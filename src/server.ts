import express, { type Express, Request, Response } from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { loadConfig, type Config } from './config/index.js';
import { DatabaseService } from './db/index.js';
import { ApiKeyQueries, UsageLogQueries, ModelConfigQueries } from './db/queries.js';
import { apiKeyAuthMiddleware, adminAuthMiddleware } from './middleware/auth.js';
import { rateLimitMiddleware, RateLimiter } from './middleware/rateLimit.js';
import { requestLogger, errorHandler } from './middleware/logger.js';
import { createRoutes } from './routes/index.js';
import { ProxyService, MeteringService, MetricsService } from './services/index.js';
import crypto from 'crypto';

function timingSafeEqual(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * LLM Proxy Server
 * 
 * Architecture:
 * ┌─────────────────────────────────────────────────────────────────┐
 * │                         Express App                             │
 * │  ┌─────────────────────────────────────────────────────────┐   │
 * │  │  Middleware Stack                                        │   │
 * │  │  1. requestLogger                                         │   │
 * │  │  2. apiKeyAuth (for /v1/*)                               │   │
 * │  │  3. rateLimit                                             │   │
 * │  │  4. adminAuth (for /admin/*)                             │   │
 * │  └─────────────────────────────────────────────────────────┘   │
 * │  ┌─────────────────────────────────────────────────────────┐   │
 * │  │  Routes                                                  │   │
 * │  │  • /v1/chat/completions (OpenAI)                        │   │
 * │  │  • /v1/messages (Anthropic)                             │   │
 * │  │  • /admin/* (Dashboard)                                  │   │
 * │  └─────────────────────────────────────────────────────────┘   │
 * └─────────────────────────────────────────────────────────────────┘
 */
export class LLMServer {
  private app: Express;
  private server: any = null;
  private wss: WebSocketServer | null = null;
  private actualPort: number = 0;
  private clients: Set<any> = new Set();
  
  /** Get the actual listening port (useful for testing) */
  getPort(): number {
    return this.actualPort;
  }
  
  /** Broadcast log entry to connected WebSocket clients */
  broadcastLog(log: any): void {
    if (this.clients.size === 0) return;
    const message = JSON.stringify({ type: 'new_log', data: log });
    for (const client of this.clients) {
      if (client.readyState === 1) { // OPEN
        client.send(message);
      }
    }
  }
  
  private config!: Config;
  private db: DatabaseService | null = null;
  private rateLimiter: RateLimiter | null = null;
  private metricsService!: MetricsService;

  constructor() {
    this.app = express();
  }

  async start(): Promise<void> {
    console.log('🚀 Starting LLM Proxy...');

    // Load configuration
    console.log('📖 Loading configuration...');
    this.config = loadConfig();

    // Initialize database
    console.log('🗄️  Initializing database...');
    this.db = new DatabaseService(this.config);
    this.db.migrate();
    
    // Seed model configuration
    this.db.seedModels(this.config.models.map((m: any) => ({
      name: m.name,
      upstream: m.upstream,
      cost_per_1k_input: m.cost_per_1k_input,
      cost_per_1k_output: m.cost_per_1k_output
    })));

    // Clean up old logs
    const deleted = this.db.cleanupOldLogs(this.config.database.retention_days);
    if (deleted > 0) {
      console.log(`🗑️  Cleaned up ${deleted} old usage logs`);
    }

    // Initialize services
    const apiKeyQueries = new ApiKeyQueries(this.db.db);
    const usageQueries = new UsageLogQueries(this.db.db);
    const modelQueries = new ModelConfigQueries(this.db.db);
    
    this.metricsService = new MetricsService();
    const proxyService = new ProxyService(modelQueries);
    const meteringService = new MeteringService(
      usageQueries,
      modelQueries,
      apiKeyQueries,
      (log) => this.broadcastLog(log)
    );
    this.rateLimiter = new RateLimiter();

    // Update active keys metric
    this.updateActiveKeysMetric(apiKeyQueries);

    // Middleware setup
    this.app.use(express.json({ limit: '10mb' }));
    this.app.use(requestLogger());

    // Routes
    const routes = createRoutes(
      proxyService,
      meteringService,
      this.metricsService,
      apiKeyQueries,
      usageQueries,
      modelQueries
    );

    // Apply auth middleware to API routes
    this.app.use('/v1', apiKeyAuthMiddleware(apiKeyQueries));
    this.app.use('/v1', rateLimitMiddleware(
      this.rateLimiter,
      { rpm: this.config.rate_limits?.default.requests_per_minute || 60,
        tpm: this.config.rate_limits?.default.tokens_per_minute || 100000 }
    ));
    
    // Admin routes with auth - must be before routes are mounted
    // Serve admin dashboard UI first (before auth middleware)
    this.app.use('/admin', express.static('src/ui'));
    
    // WebSocket endpoint - must be before auth middleware
    // WebSocket upgrade is handled separately below
    
    this.app.use('/admin', adminAuthMiddleware(this.config.admin));
    
    this.app.use('/', routes);

    // Metrics endpoint (no auth - can be restricted if needed)
    this.app.get('/metrics', this.metricsService.getMetricsHandler());

    // Error handler (4 arguments = error handler)
    this.app.use(errorHandler);

    // Start server with HTTP server for WebSocket support
    return new Promise((resolve, reject) => {
      this.server = createServer(this.app);
      
      // Initialize WebSocket server
      this.wss = new WebSocketServer({ 
        server: this.server, 
        path: '/admin/ws',
        handleProtocols: (protocols, request) => {
          // Authenticate WebSocket handshake
          const authHeader = request.headers.authorization;
          const adminKey = request.headers['x-admin-key'];
          
          // Check API key first
          if (adminKey && typeof adminKey === 'string' && 
              timingSafeEqual(adminKey, this.config.admin.api_key)) {
            return protocols.size > 0 ? Array.from(protocols)[0] : false;
          }
          
          // Check Basic Auth
          if (authHeader && authHeader.startsWith('Basic ')) {
            const base64Credentials = authHeader.substring(6);
            const credentials = Buffer.from(base64Credentials, 'base64').toString('utf-8');
            const [username, password] = credentials.split(':', 2);
            
            if (timingSafeEqual(username, this.config.admin.username) && 
                timingSafeEqual(password, this.config.admin.password)) {
              return protocols.size > 0 ? Array.from(protocols)[0] : false;
            }
          }
          
          // Authentication failed
          return false;
        }
      });
      
      this.wss.on('connection', (ws: any) => {
        this.clients.add(ws);
        console.log(`🔌 WebSocket client connected (${this.clients.size} total)`);
        
        ws.on('close', () => {
          this.clients.delete(ws);
          console.log(`🔌 WebSocket client disconnected (${this.clients.size} total)`);
        });
        
        ws.on('error', (error: Error) => {
          console.error('WebSocket error:', error);
          this.clients.delete(ws);
        });
      });
      
      this.server.listen(this.config.server.port, this.config.server.host, () => {
        const addr = this.server.address() as { port: number };
        this.actualPort = addr?.port || this.config.server.port;
        console.log(`✅ Server running on http://${this.config.server.host}:${this.actualPort}`);
        console.log(`📊 Metrics available at http://${this.config.server.host}:${this.actualPort}/metrics`);
        console.log(`🔧 Admin dashboard at http://${this.config.server.host}:${this.actualPort}/admin`);
        console.log(`🔌 WebSocket at ws://${this.config.server.host}:${this.actualPort}/admin/ws`);
        console.log(`📝 Models configured: ${this.config.models.map((m: any) => m.name).join(', ')}`);
        resolve();
      });
      this.server.on('error', reject);
    });
  }

  private updateActiveKeysMetric(apiKeyQueries: ApiKeyQueries): void {
    const keys = apiKeyQueries.listKeys();
    const activeCount = keys.filter(k => k.isActive).length;
    this.metricsService.setActiveKeys(activeCount);

    // Update every minute
    this.intervalId = setInterval(() => {
      const keys = apiKeyQueries.listKeys();
      const activeCount = keys.filter(k => k.isActive).length;
      this.metricsService.setActiveKeys(activeCount);
    }, 60000);
  }

  private intervalId: NodeJS.Timeout | null = null;

  async stop(): Promise<void> {
    console.log('🛑 Shutting down...');
    if (this.intervalId) {
      clearInterval(this.intervalId);
    }
    if (this.rateLimiter) {
      this.rateLimiter.cleanup();
    }
    // Close WebSocket connections
    if (this.wss) {
      this.wss.close();
      for (const client of this.clients) {
        client.close();
      }
      this.clients.clear();
    }
    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server.close(() => resolve());
      });
    }
    if (this.db) {
      this.db.close();
    }
    // Don't call process.exit in tests - let the test framework handle it
    if (!process.env.VITEST) {
      process.exit(0);
    }
  }
}

// Start server
const server = new LLMServer();

server.start().catch(err => {
  console.error('Failed to start server:', err);
  // Don't call process.exit in tests
  if (!process.env.VITEST) {
    process.exit(1);
  }
});

// Graceful shutdown
process.on('SIGINT', () => server.stop());
process.on('SIGTERM', () => server.stop());

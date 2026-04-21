import express, { type Express, Request, Response } from 'express';
import { createServer, type Server } from 'http';
import { WebSocketServer, type WebSocket } from 'ws';
import { loadConfig, type Config } from './config/index.js';
import { DatabaseService } from './db/index.js';
import { ApiKeyQueries, UsageLogQueries, ModelConfigQueries } from './db/queries.js';
import { apiKeyAuthMiddleware, adminAuthMiddleware } from './middleware/auth.js';
import { rateLimitMiddleware, RateLimiter } from './middleware/rateLimit.js';
import { requestLogger, errorHandler } from './middleware/logger.js';
import { createRoutes } from './routes/index.js';
import { ProxyService, MeteringService, MetricsService, ScaleToZeroService } from './services/index.js';
import { timingSafeEqual } from './utils/crypto.js';

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
  private server: Server | null = null;
  private wss: WebSocketServer | null = null;
  private actualPort: number = 0;
  private clients: Set<WebSocket> = new Set();
  
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
  private scaleToZeroService: ScaleToZeroService | null = null;

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
    
    // Initialize scale-to-zero service
    this.scaleToZeroService = new ScaleToZeroService();
    
    const proxyService = new ProxyService(modelQueries, this.scaleToZeroService);
    
    // Initialize scale-to-zero for models that have it configured
    proxyService.initScaleToZero(this.config.models);
    
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
      modelQueries,
      this.config.admin
    );

    // Apply auth middleware to API routes
    this.app.use('/v1', apiKeyAuthMiddleware(apiKeyQueries));
    const defaultRateLimits = this.config.rate_limits
      ? { rpm: this.config.rate_limits.default.requests_per_minute ?? Infinity,
          tpm: this.config.rate_limits.default.tokens_per_minute ?? Infinity }
      : null;
    this.app.use('/v1', rateLimitMiddleware(this.rateLimiter, defaultRateLimits));
    
    // Health check endpoint (no auth - for Docker healthchecks)
    this.app.get('/health', (req: Request, res: Response) => {
      res.json({ status: 'ok', timestamp: new Date().toISOString() });
    });

    // Root endpoint - landing page with status and quick links
    this.app.get('/', (req: Request, res: Response) => {
      const isHtml = req.headers.accept?.includes('text/html');
      
      if (isHtml) {
        res.setHeader('Content-Type', 'text/html');
        res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>LLM Proxy</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #fafafa;
      color: #171717;
      line-height: 1.6;
      padding: 60px 20px;
    }
    .container { max-width: 600px; margin: 0 auto; }
    h1 { font-size: 32px; margin-bottom: 8px; }
    .subtitle { color: #737373; margin-bottom: 32px; font-size: 16px; }
    .status {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      background: #16a34a;
      color: white;
      padding: 4px 12px;
      border-radius: 9999px;
      font-size: 14px;
      font-weight: 500;
      margin-bottom: 24px;
    }
    .status::before {
      content: '';
      width: 8px;
      height: 8px;
      background: white;
      border-radius: 50%;
    }
    .links {
      display: grid;
      gap: 12px;
      margin-top: 32px;
    }
    .link-card {
      background: white;
      border: 1px solid #e5e5e5;
      border-radius: 8px;
      padding: 16px;
      text-decoration: none;
      color: #171717;
      transition: border-color 0.2s;
    }
    .link-card:hover { border-color: #2563eb; }
    .link-title { font-weight: 600; font-size: 16px; margin-bottom: 4px; }
    .link-desc { color: #737373; font-size: 14px; }
    .endpoint {
      font-family: 'SF Mono', 'Fira Code', monospace;
      background: #f0f0f0;
      padding: 2px 6px;
      border-radius: 3px;
      font-size: 13px;
      color: #2563eb;
    }
    .footer {
      margin-top: 40px;
      padding-top: 24px;
      border-top: 1px solid #e5e5e5;
      color: #a3a3a3;
      font-size: 13px;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>LLM Proxy</h1>
    <p class="subtitle">Lightweight, self-hosted LLM gateway</p>
    
    <div class="status">● Running</div>
    
    <p>OpenAI and Anthropic-compatible API proxy for your local inference servers.</p>
    
    <div class="links">
      <a href="/admin" class="link-card">
        <div class="link-title">Admin Dashboard</div>
        <div class="link-desc">Manage API keys, view usage, monitor costs</div>
      </a>
      
      <a href="/metrics" class="link-card">
        <div class="link-title">Prometheus Metrics</div>
        <div class="link-desc">Raw metrics at <span class="endpoint">/metrics</span></div>
      </a>
      
      <a href="/health" class="link-card">
        <div class="link-title">Health Check</div>
        <div class="link-desc">Service status at <span class="endpoint">/health</span></div>
      </a>
      
      <a href="https://github.com/rot13maxi/llm_proxy" target="_blank" rel="noopener" class="link-card">
        <div class="link-title">Documentation</div>
        <div class="link-desc">GitHub repo with full docs</div>
      </a>
    </div>
    
    <div class="footer">
      <p>Endpoints: <span class="endpoint">POST /v1/chat/completions</span> | <span class="endpoint">POST /v1/messages</span></p>
    </div>
  </div>
</body>
</html>
        `);
      } else {
        // JSON response for API clients
        res.json({
          name: 'LLM Proxy',
          status: 'running',
          endpoints: {
            health: '/health',
            admin: '/admin',
            metrics: '/metrics',
            openai: 'POST /v1/chat/completions',
            anthropic: 'POST /v1/messages'
          },
          docs: 'https://github.com/rot13maxi/llm_proxy'
        });
      }
    });

    // Admin health check (alias, requires auth)
    this.app.get('/admin/health', adminAuthMiddleware(this.config.admin), (req: Request, res: Response) => {
      res.json({ status: 'ok', timestamp: new Date().toISOString() });
    });

    // Mount routes (admin API routes come first)
    this.app.use('/', routes);
    
    // Serve admin dashboard UI (static files, after routes so API endpoints take precedence)
    this.app.use('/admin', express.static('src/ui'));

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
      
      this.wss.on('connection', (ws: WebSocket) => {
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
        const addr = this.server!.address() as { port: number };
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
    // Shutdown scale-to-zero service
    if (this.scaleToZeroService) {
      await this.scaleToZeroService.shutdown();
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
        this.server!.close(() => resolve());
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

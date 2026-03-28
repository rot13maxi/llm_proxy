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
    this.app.get('/', async (req: Request, res: Response) => {
      const isHtml = req.headers.accept?.includes('text/html');
      const models = modelQueries.listModels();
      
      // Check health of each model server-side
      const modelHealth = await Promise.all(models.map(async (model) => {
        try {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 2000);
          
          const modelsEndpoint = model.upstream.replace('/v1/chat/completions', '/v1/models');
          const response = await fetch(modelsEndpoint, {
            method: 'GET',
            signal: controller.signal
          });
          
          clearTimeout(timeoutId);
          return { name: model.name, healthy: response.ok };
        } catch {
          return { name: model.name, healthy: false };
        }
      }));
      
      if (isHtml) {
        res.setHeader('Content-Type', 'text/html');
        res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>LLM Proxy</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600&family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
  <style>
    :root {
      --primary: #0066ff;
      --success: #00c987;
      --warning: #ffc107;
      --error: #ff4444;
      
      --bg: #ffffff;
      --bg-subtle: #f8faff;
      --border: #000000;
      --border-subtle: #e5e5e5;
      --text-primary: #000000;
      --text-muted: #4a5568;
      --text-subtle: #999999;
      
      --space-sm: 8px;
      --space-md: 12px;
      --space-lg: 16px;
      --space-xl: 20px;
      --space-2xl: 24px;
      
      --radius-sm: 0px;
      --radius-md: 0px;
      
      --font-display: 'Geist', -apple-system, BlinkMacSystemFont, sans-serif;
      --font-body: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
      --font-code: 'JetBrains Mono', 'Fira Code', monospace;
      
      --shadow-sm: 2px 2px 0px #000000;
      --shadow-md: 4px 4px 0px #000000;
    }
    
    @media (prefers-color-scheme: dark) {
      :root {
        --bg: #0a0a0a;
        --bg-subtle: #1a1a1a;
        --border: #ffffff;
        --border-subtle: #333333;
        --text-primary: #ffffff;
        --text-muted: #a0a0a0;
        --text-subtle: #666666;
        --primary: #4da3ff;
      }
    }
    
    * { box-sizing: border-box; margin: 0; padding: 0; }
    
    body {
      font-family: var(--font-body);
      background: var(--bg);
      color: var(--text-primary);
      line-height: 1.5;
      font-size: 14px;
      -webkit-font-smoothing: antialiased;
      padding: var(--space-2xl) var(--space-lg);
    }
    
    .container {
      max-width: 900px;
      margin: 0 auto;
    }
    
    h1, h2, h3 {
      font-family: var(--font-display);
      font-weight: 600;
      line-height: 1.25;
      letter-spacing: -0.02em;
    }
    
    h1 { font-size: 28px; }
    h2 { font-size: 20px; }
    
    .page-header {
      margin-bottom: var(--space-2xl);
      padding-bottom: var(--space-xl);
      border-bottom: 3px solid var(--border);
    }
    
    .subtitle {
      color: var(--text-muted);
      font-size: 16px;
      margin-top: var(--space-sm);
    }
    
    .status-badge {
      display: inline-flex;
      align-items: center;
      gap: var(--space-xs);
      padding: var(--space-xs) var(--space-sm);
      border-radius: var(--radius-sm);
      font-family: var(--font-code);
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      border: 2px solid var(--border);
      font-weight: 600;
      margin-top: var(--space-md);
    }
    
    .status-badge.connected {
      background: var(--success);
      color: white;
    }
    
    .links-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
      gap: var(--space-md);
      margin: var(--space-2xl) 0;
    }
    
    .link-card {
      background: var(--bg);
      border: 2px solid var(--border);
      border-radius: var(--radius-md);
      padding: var(--space-lg);
      text-decoration: none;
      color: var(--text-primary);
      transition: all 150ms ease;
      box-shadow: var(--shadow-sm);
    }
    
    .link-card:hover {
      transform: translate(-2px, -2px);
      box-shadow: var(--shadow-md);
    }
    
    .link-title {
      font-family: var(--font-display);
      font-weight: 600;
      font-size: 16px;
      margin-bottom: var(--space-xs);
    }
    
    .link-desc {
      color: var(--text-muted);
      font-size: 13px;
    }
    
    .endpoint {
      font-family: var(--font-code);
      background: var(--bg-subtle);
      padding: 2px 6px;
      border-radius: var(--radius-sm);
      font-size: 12px;
      color: var(--primary);
      border: 1px solid var(--border);
    }
    
    .section-title {
      font-family: var(--font-display);
      font-size: 20px;
      font-weight: 600;
      margin: var(--space-2xl) 0 var(--space-lg);
    }
    
    .models-card {
      background: var(--bg);
      border: 2px solid var(--border);
      border-radius: var(--radius-md);
      padding: var(--space-lg);
      box-shadow: var(--shadow-sm);
    }
    
    .models-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 13px;
    }
    
    .models-table th {
      text-align: left;
      padding: var(--space-sm) var(--space-md);
      font-family: var(--font-code);
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--text-muted);
      border-bottom: 2px solid var(--border);
      font-weight: 600;
    }
    
    .models-table td {
      padding: var(--space-sm) var(--space-md);
      border-bottom: 1px solid var(--border-subtle);
      font-size: 12px;
    }
    
    .models-table tr:last-child td {
      border-bottom: none;
    }
    
    .model-name {
      font-family: var(--font-display);
      font-weight: 600;
    }
    
    .model-upstream {
      font-family: var(--font-code);
      font-size: 12px;
      color: var(--primary);
      word-break: break-all;
    }
    
    .model-cost {
      font-family: var(--font-code);
      font-size: 12px;
      color: var(--text-muted);
    }
    
    .health-status {
      display: inline-flex;
      align-items: center;
      gap: var(--space-xs);
      padding: var(--space-xs) var(--space-sm);
      border-radius: var(--radius-sm);
      font-family: var(--font-code);
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      border: 2px solid var(--border);
      font-weight: 600;
    }
    
    .health-status.healthy {
      background: var(--success);
      color: white;
    }
    
    .health-status.unhealthy {
      background: var(--error);
      color: white;
    }
    
    .health-status.checking {
      background: var(--bg-subtle);
      color: var(--text-muted);
    }
    
    .footer {
      margin-top: var(--space-2xl);
      padding-top: var(--space-xl);
      border-top: 2px solid var(--border-subtle);
      color: var(--text-muted);
      font-size: 12px;
    }
    
    @media (max-width: 768px) {
      body {
        padding: var(--space-lg) var(--space-md);
      }
      
      .links-grid {
        grid-template-columns: 1fr;
      }
      
      .models-table {
        font-size: 12px;
      }
      
      .models-table th, .models-table td {
        padding: var(--space-sm);
      }
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="page-header">
      <h1>LLM Proxy</h1>
      <p class="subtitle">Lightweight, self-hosted LLM gateway</p>
      <div class="status-badge connected">● Running</div>
    </div>
    
    <p style="color: var(--text-muted);">OpenAI and Anthropic-compatible API proxy for your local inference servers.</p>
    
    <div class="links-grid">
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
    
    <h2 class="section-title">Configured Models</h2>
    <div class="models-card">
      <table class="models-table">
        <thead>
          <tr>
            <th>Model</th>
            <th>Upstream</th>
            <th>Cost (1K)</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          ${models.map(m => {
            const safeName = m.name.replace(/\s/g, '-');
            const health = modelHealth.find(h => h.name === m.name);
            const isHealthy = health?.healthy ?? false;
            return `
          <tr data-model="${m.name}">
            <td class="model-name">${m.name}</td>
            <td class="model-upstream">${m.upstream}</td>
            <td class="model-cost">$${m.costPer1kInput}/$${m.costPer1kOutput}</td>
            <td><span class="health-status ${isHealthy ? 'healthy' : 'unhealthy'}">${isHealthy ? '● Online' : '✗ Offline'}</span></td>
          </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>
    
    <div class="footer">
      <p>Endpoints: <span class="endpoint">POST /v1/chat/completions</span> | <span class="endpoint">POST /v1/messages</span></p>
    </div>
  </div>
  
  <script>
    // Health status is pre-computed server-side
  </script>
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

    // Model health check endpoint
    this.app.get('/admin/models/health', async (req: Request, res: Response) => {
      const models = modelQueries.listModels();
      const healthChecks = await Promise.all(models.map(async (model) => {
        try {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 3000);
          
          const modelsEndpoint = model.upstream.replace('/v1/chat/completions', '/v1/models');
          const response = await fetch(modelsEndpoint, {
            method: 'GET',
            signal: controller.signal
          });
          
          clearTimeout(timeoutId);
          return { name: model.name, healthy: response.ok };
        } catch {
          return { name: model.name, healthy: false };
        }
      }));
      res.json({ models: healthChecks });
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

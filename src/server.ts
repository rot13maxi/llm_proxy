import express, { type Express, Request, Response } from 'express';
import cookieParser from 'cookie-parser';
import { createServer, type Server } from 'http';
import { WebSocketServer, type WebSocket } from 'ws';
import { loadConfig, type Config } from './config/index.js';
import { DatabaseService } from './db/index.js';
import { ApiKeyQueries, UsageLogQueries, ModelConfigQueries, ModelAliasQueries } from './db/queries.js';
import { apiKeyAuthMiddleware, adminAuthMiddleware } from './middleware/auth.js';
import { rateLimitMiddleware, RateLimiter } from './middleware/rateLimit.js';
import { requestLogger, errorHandler } from './middleware/logger.js';
import { createRoutes } from './routes/index.js';
import { ProxyService, MeteringService, MetricsService, ScaleToZeroService, ModelAliasService, ContainerManager } from './services/index.js';
import { timingSafeEqual } from './utils/crypto.js';
import { sessionStore } from './utils/session.js';

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
    
    // Seed model aliases from config
    this.db.seedModelAliases(this.config.model_aliases || []);

    // Clean up old logs
    const deleted = this.db.cleanupOldLogs(this.config.database.retention_days);
    if (deleted > 0) {
      console.log(`🗑️  Cleaned up ${deleted} old usage logs`);
    }

    // Initialize services
    const apiKeyQueries = new ApiKeyQueries(this.db.db);
    const usageQueries = new UsageLogQueries(this.db.db);
    const modelQueries = new ModelConfigQueries(this.db.db);
    const modelAliasQueries = new ModelAliasQueries(this.db.db);
    
    this.metricsService = new MetricsService();

    // Initialize container manager for models with manual container config (alias flips)
    const containerManager = new ContainerManager();
    for (const model of this.config.models) {
      if (model.container?.enabled && model.container.container_name) {
        containerManager.register(model.name, {
          containerName: model.container.container_name,
          backendPort: model.container.backend_port ?? 8000,
          healthCheckPath: model.container.health_check_path,
          startTimeoutSeconds: model.container.start_timeout_seconds
        });
      }
    }

    // Initialize scale-to-zero service (only for models with scale_to_zero config)
    this.scaleToZeroService = new ScaleToZeroService();

    // Initialize model alias service
    const modelAliasService = new ModelAliasService(modelAliasQueries, modelQueries, containerManager);

    const proxyService = new ProxyService(modelQueries, modelAliasService, this.scaleToZeroService);
    proxyService.initScaleToZero(this.config.models.filter(m => m.scale_to_zero?.enabled));
    
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
    this.app.use(cookieParser());
    this.app.use(requestLogger());

    // Routes
    const routes = createRoutes(
      proxyService,
      meteringService,
      this.metricsService,
      apiKeyQueries,
      usageQueries,
      modelQueries,
      this.config.admin,
      modelAliasService,
      modelAliasQueries
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
      const currentAliasModel = modelAliasQueries.getAlias('current');
      const allAliases = modelAliasQueries.listAliases();
      const isAuthenticated = this.isAdminAuthenticated(req);
      const adminAuthHeader = isAuthenticated 
        ? 'Basic ' + Buffer.from(`${this.config.admin.username}:${this.config.admin.password}`).toString('base64')
        : '';
      
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
<body>
  <nav style="background: var(--bg); border-bottom: 3px solid var(--border); padding: 0 var(--space-lg); position: sticky; top: 0; z-index: 100; box-shadow: var(--shadow-sm);">
    <div style="max-width: 900px; margin: 0 auto; display: flex; align-items: center; justify-content: space-between; height: 56px; padding: 0 var(--space-lg);">
      <a href="/" style="font-family: var(--font-display); font-size: 16px; font-weight: 600; display: flex; align-items: center; gap: var(--space-sm); color: var(--text-primary); letter-spacing: -0.02em; text-decoration: none;">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <path stroke-linecap="round" stroke-linejoin="round" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"/>
        </svg>
        LLM Proxy
      </a>
      <div style="display: flex; gap: 4px;">
        <a href="/admin#keys" style="color: var(--text-muted); text-decoration: none; padding: 8px 12px; border-radius: 0px; transition: all 150ms ease; cursor: pointer; border: 2px solid var(--border); background: var(--bg); font-size: 12px; font-weight: 600; letter-spacing: 0.01em;">API Keys</a>
        <a href="/admin#logs" style="color: var(--text-muted); text-decoration: none; padding: 8px 12px; border-radius: 0px; transition: all 150ms ease; cursor: pointer; border: 2px solid var(--border); background: var(--bg); font-size: 12px; font-weight: 600; letter-spacing: 0.01em;">Live Logs</a>
        <a href="/admin#metrics" style="color: var(--text-muted); text-decoration: none; padding: 8px 12px; border-radius: 0px; transition: all 150ms ease; cursor: pointer; border: 2px solid var(--border); background: var(--bg); font-size: 12px; font-weight: 600; letter-spacing: 0.01em;">Metrics</a>
      </div>
    </div>
  </nav>
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
            const pointingAliases = allAliases.filter(a => a.pointsTo === m.name).map(a => a.aliasName);
            const aliasTag = pointingAliases.length > 0
              ? pointingAliases.map(a => `<span class="alias-tag">${a}</span>`).join('')
              : '';
            return `
          <tr data-model="${m.name}">
            <td class="model-name">${m.name}${aliasTag}</td>
            <td class="model-upstream">${m.upstream}</td>
            <td class="model-cost">$${m.costPer1kInput}/$${m.costPer1kOutput}</td>
            <td><span class="health-status ${isHealthy ? 'healthy' : 'unhealthy'}">${isHealthy ? '● Online' : '✗ Offline'}</span></td>
          </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>
    
    <!-- Model Switcher - always rendered, shown/hidden based on auth -->
    <div id="model-switcher-section" style="display: ${isAuthenticated ? 'block' : 'none'};">
      <h2 class="section-title">Model Switcher</h2>
      <div class="models-card">
        <div class="model-switcher">
          <div class="current-model">
            <span class="label">CURRENT MODEL</span>
            <span class="model-name" id="current-model-display">${currentAliasModel || 'Not set'}</span>
          </div>
          
          <div class="switcher-controls">
            <label class="label">SWITCH TO:</label>
            <select id="model-select">
              <option value="">-- Select model --</option>
              ${models.filter(m => m.name !== currentAliasModel).map(m => `
                <option value="${m.name}">${m.name}</option>
              `).join('')}
            </select>
            
            <button class="btn btn-primary" id="flip-btn" onclick="flipModel()" disabled>
              Switch Model
            </button>
          </div>
          
          <div class="switcher-status" id="switcher-status" style="display: none;">
            <span class="spinner"></span>
            <span class="status-text">Switching models...</span>
          </div>
          
          <div class="switcher-error" id="switcher-error" style="display: none;">
            <span class="error-icon">✗</span>
            <span class="error-text"></span>
          </div>
        </div>
      </div>
    </div>
    
    <div class="footer">
      <p>Endpoints: <span class="endpoint">POST /v1/chat/completions</span> | <span class="endpoint">POST /v1/messages</span></p>
    </div>
  </div>
  
  <script>
    // Check auth status via cookie-based session
    async function checkAuth() {
      try {
        const res = await fetch('/admin/auth/status', { credentials: 'same-origin' });
        const data = await res.json();
        return data.authenticated;
      } catch {
        return false;
      }
    }

    // Show/hide model switcher based on auth
    async function updateModelSwitcherVisibility() {
      const isAuthenticated = await checkAuth();
      const switcherSection = document.getElementById('model-switcher-section');
      if (switcherSection) {
        switcherSection.style.display = isAuthenticated ? 'block' : 'none';
      }
    }

    // Flip model function
    async function flipModel() {
      const select = document.getElementById('model-select');
      const status = document.getElementById('switcher-status');
      const error = document.getElementById('switcher-error');
      const btn = document.getElementById('flip-btn');

      const targetModel = select.value;
      if (!targetModel) return;

      status.style.display = 'flex';
      error.style.display = 'none';
      btn.disabled = true;

      try {
        const response = await fetch('/admin/aliases/current/flip', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-CSRF-Secret': document.cookie.split('; ').find(row => row.startsWith('csrf_token='))?.split('=')[1] || ''
          },
          credentials: 'same-origin',
          body: JSON.stringify({ 
            targetModel,
            csrf_secret: document.cookie.split('; ').find(row => row.startsWith('csrf_token='))?.split('=')[1]
          })
        });

        const result = await response.json();

        if (result.success) {
          document.getElementById('current-model-display').textContent = result.newModel;
          select.value = '';
          location.reload();
        } else {
          throw new Error(result.error || 'Flip failed');
        }
      } catch (err) {
        error.style.display = 'flex';
        error.querySelector('.error-text').textContent = err.message;
      } finally {
        status.style.display = 'none';
        btn.disabled = false;
      }
    }

    // Initialize on page load
    document.addEventListener('DOMContentLoaded', () => {
      updateModelSwitcherVisibility();
      
      const select = document.getElementById('model-select');
      if (select) {
        select.addEventListener('change', () => {
          document.getElementById('flip-btn').disabled = !select.value;
        });
      }
    });
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

  private isAdminAuthenticated(req: Request): boolean {
    // Check session cookie first
    const sessionCookie = req.cookies?.session_id;
    if (sessionCookie && sessionStore.validateSession(sessionCookie)) {
      return true;
    }

    const adminKey = req.headers['x-admin-key'];
    const authHeader = req.headers.authorization;

    if (adminKey && typeof adminKey === 'string' &&
        timingSafeEqual(adminKey, this.config.admin.api_key)) {
      return true;
    }

    if (authHeader && authHeader.startsWith('Basic ')) {
      const base64Credentials = authHeader.substring(6);
      const credentials = Buffer.from(base64Credentials, 'base64').toString('utf-8');
      const [username, password] = credentials.split(':', 2);

      if (timingSafeEqual(username, this.config.admin.username) &&
          timingSafeEqual(password, this.config.admin.password)) {
        return true;
      }
    }

    return false;
  }

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

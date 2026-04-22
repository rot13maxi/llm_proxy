import express, { type Express, Request, Response } from 'express';
import { createServer, type Server } from 'http';
import { WebSocketServer, type WebSocket } from 'ws';
import { loadConfig, type Config } from './config/index.js';
import { DatabaseService } from './db/index.js';
import { ApiKeyQueries, UsageLogQueries, ModelConfigQueries, ModelAliasQueries } from './db/queries.js';
import { apiKeyAuthMiddleware, adminAuthMiddleware } from './middleware/auth.js';
import { rateLimitMiddleware, RateLimiter } from './middleware/rateLimit.js';
import { requestLogger, errorHandler } from './middleware/logger.js';
import { createRoutes } from './routes/index.js';
import { ProxyService, MeteringService, MetricsService, ScaleToZeroService, ModelOrchestrationService } from './services/index.js';
import { timingSafeEqual } from './utils/crypto.js';

/**
 * Landing page. Public (no auth) — shows configured models with prices and the
 * alias control. The alias picker uses localStorage-cached admin credentials;
 * on 401 it prompts inline, then retries.
 *
 * All dynamic content is rendered via textContent / DOM methods — never
 * innerHTML — so even if config.yaml somehow contained exotic values, they
 * can't inject markup.
 */
const LANDING_PAGE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>LLM Proxy</title>

  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Archivo+Black&family=Geist:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600;700&family=Inter:wght@400;500;600;900&family=JetBrains+Mono:wght@400;500;600&family=Oswald:wght@400;500;600;700&family=Space+Grotesk:wght@400;500;700&family=VT323&family=Work+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet">

  <script src="/themes/picker.js"></script>
  <link rel="stylesheet" href="/themes/base.css">
  <link rel="stylesheet" id="theme-css" href="/themes/theme-paper.css">
</head>
<body>
  <nav class="nav">
    <div class="nav-container">
      <a class="nav-brand" href="/">LLM <span>Proxy</span></a>
      <div class="nav-links">
        <a class="nav-link" href="/admin">Admin</a>
        <a class="nav-link" href="/metrics">Metrics</a>
        <a class="nav-link" href="/health">Health</a>
        <a class="nav-link" href="https://github.com/rot13maxi/llm_proxy">Docs</a>
      </div>
      <div class="connection-status connected"><span class="connection-dot"></span>Running</div>
    </div>
  </nav>

  <main class="container narrow">
    <div class="page-header">
      <div class="page-title">
        <h1>LLM Proxy</h1>
        <small>self-hosted · OpenAI + Anthropic compatible</small>
      </div>
    </div>

    <h2>Alias</h2>
    <div class="card alias-card" id="alias-section">
      <div class="loading"><span class="spinner"></span>Loading…</div>
    </div>

    <h2 style="margin-top: 28px;">Models</h2>
    <div class="card" id="models-section">
      <div class="loading"><span class="spinner"></span>Loading…</div>
    </div>

    <h2 style="margin-top: 28px;">Endpoints</h2>
    <div class="link-grid">
      <a class="link-card" href="/admin">Admin dashboard</a>
      <a class="link-card" href="/metrics">Prometheus metrics</a>
      <a class="link-card" href="/health">Health check</a>
      <a class="link-card" href="https://github.com/rot13maxi/llm_proxy">Documentation</a>
    </div>

    <p style="margin-top: 28px; font-size: 12px; opacity: 0.7;">
      <code>POST /v1/chat/completions</code>  ·
      <code>POST /v1/messages</code>
    </p>
  </main>

  <dialog id="auth-dialog" style="border:0; padding:0; background:transparent;">
    <div class="card" style="max-width: 360px; min-width: 320px;">
      <form id="auth-form">
        <h3 style="margin-bottom: 12px;">Admin credentials</h3>
        <p style="margin-bottom: 14px; font-size: 12px; opacity: 0.7;">Needed to flip the alias.</p>
        <div class="form-group"><label>Username</label><input type="text" id="auth-username" autocomplete="username"></div>
        <div class="form-group"><label>Password</label><input type="password" id="auth-password" autocomplete="current-password"></div>
        <div class="form-group"><label>Or Admin API key</label><input type="password" id="auth-api-key" autocomplete="off" placeholder="sk-…"></div>
        <div class="modal-actions">
          <button type="button" class="btn btn-ghost" id="auth-cancel">Cancel</button>
          <button type="submit" class="btn btn-primary">Save</button>
        </div>
      </form>
    </div>
  </dialog>

  <script>
    const AUTH_KEY = 'llm-proxy-admin-auth';
    const getAuth = () => { try { return JSON.parse(localStorage.getItem(AUTH_KEY) || 'null'); } catch { return null; } };
    const setAuth = (a) => localStorage.setItem(AUTH_KEY, JSON.stringify(a));
    const clearAuthCreds = () => localStorage.removeItem(AUTH_KEY);
    const authHeader = (a) => {
      if (!a) return {};
      if (a.apiKey) return { 'X-Admin-Key': a.apiKey };
      if (a.username && a.password) return { 'Authorization': 'Basic ' + btoa(a.username + ':' + a.password) };
      return {};
    };

    function el(tag, props, ...children) {
      const n = document.createElement(tag);
      if (props) {
        for (const [k, v] of Object.entries(props)) {
          if (k === 'class') n.className = v;
          else if (k === 'dataset') Object.assign(n.dataset, v);
          else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2).toLowerCase(), v);
          else if (k === 'text') n.textContent = v;
          else if (k === 'style') Object.assign(n.style, v);
          else n.setAttribute(k, v);
        }
      }
      for (const c of children) if (c != null) n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
      return n;
    }
    function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

    async function promptAuth() {
      const dlg = document.getElementById('auth-dialog');
      const form = document.getElementById('auth-form');
      const cancel = document.getElementById('auth-cancel');
      const u = document.getElementById('auth-username');
      const p = document.getElementById('auth-password');
      const k = document.getElementById('auth-api-key');
      u.value = ''; p.value = ''; k.value = '';
      dlg.showModal();
      return new Promise((resolve) => {
        const done = (v) => { dlg.close(); cancel.removeEventListener('click', onCancel); form.removeEventListener('submit', onSubmit); resolve(v); };
        const onSubmit = (e) => { e.preventDefault(); done(k.value ? { apiKey: k.value } : { username: u.value, password: p.value }); };
        const onCancel = () => done(null);
        form.addEventListener('submit', onSubmit);
        cancel.addEventListener('click', onCancel);
      });
    }

    function fmtPrice(v) {
      if (v == null) return '—';
      return '$' + Number(v).toFixed(4).replace(/0+$/, '').replace(/\\.$/, '');
    }

    async function loadModels() {
      const host = document.getElementById('models-section');
      clear(host);
      try {
        const res = await fetch('/models');
        const { models } = await res.json();
        if (!models.length) { host.appendChild(el('div', { class: 'empty-state', text: 'No models configured.' })); return; }
        const wrap = el('div', { class: 'table-container' });
        const table = el('table');
        const thead = el('thead', null, el('tr', null,
          el('th', { text: 'Name' }),
          el('th', { class: 'num', text: 'Input / 1k' }),
          el('th', { class: 'num', text: 'Output / 1k' }),
          el('th', { text: 'Status' })
        ));
        const tbody = el('tbody');
        for (const m of models) {
          tbody.appendChild(el('tr', null,
            el('td', null, el('code', { text: m.name })),
            el('td', { class: 'num', text: fmtPrice(m.cost_per_1k_input) }),
            el('td', { class: 'num', text: fmtPrice(m.cost_per_1k_output) }),
            el('td', null, m.orchestrated
              ? el('span', { class: 'status-badge success', text: 'orchestrated' })
              : el('span', { class: 'status-badge inactive', text: '—' }))
          ));
        }
        table.appendChild(thead); table.appendChild(tbody);
        wrap.appendChild(table);
        host.appendChild(wrap);
      } catch (err) {
        clear(host); host.appendChild(el('div', { class: 'alert alert-error', text: 'Failed to load models.' }));
      }
    }

    let state = { aliases: [], models: [], orchestrationEnabled: false };

    async function loadAliases() {
      const host = document.getElementById('alias-section');
      try {
        const [aliasRes, modelsRes] = await Promise.all([fetch('/aliases'), fetch('/models')]);
        state.aliases = (await aliasRes.json()).aliases;
        const m = await modelsRes.json();
        state.models = m.models;
        state.orchestrationEnabled = (await (await fetch('/aliases')).json()).orchestrationEnabled;
        renderAliases();
      } catch (err) {
        clear(host); host.appendChild(el('div', { class: 'alert alert-error', text: 'Failed to load aliases.' }));
      }
    }

    function renderAliases() {
      const host = document.getElementById('alias-section');
      clear(host);
      if (!state.aliases.length) {
        host.appendChild(el('div', { class: 'empty-state', text: 'No aliases configured. Add an ' }));
        host.lastChild.appendChild(el('code', { text: 'aliases:' }));
        host.lastChild.appendChild(document.createTextNode(' section to config.yaml.'));
        return;
      }
      for (const a of state.aliases) {
        const select = el('select', { dataset: { alias: a.name } });
        for (const m of state.models) {
          const opt = el('option', { value: m.name, text: m.name });
          if (m.name === a.target) opt.selected = true;
          select.appendChild(opt);
        }
        const btn = el('button', { class: 'btn btn-primary', dataset: { alias: a.name }, onclick: () => flipAlias(a.name) }, 'Switch');
        const toast = el('div', { class: 'alert', dataset: { toast: a.name }, style: { display: 'none', marginTop: '10px' } });
        const row = el('div', { class: 'alias-row' },
          el('span', { class: 'alias-name code', text: a.name }),
          el('span', { class: 'alias-arrow', text: '→' }),
          el('span', { class: 'alias-target code', text: a.target }),
          el('span', { class: 'fill' }),
          select,
          btn
        );
        host.appendChild(row);
        host.appendChild(toast);
      }
      if (state.orchestrationEnabled) {
        host.appendChild(el('div', { class: 'alias-note', text: 'Flipping stops the current container, then starts and health-checks the new one. Expect a brief outage.' }));
      }
    }

    function showToast(aliasName, kind, text) {
      const host = document.querySelector('[data-toast="' + CSS.escape(aliasName) + '"]');
      if (!host) return;
      host.className = 'alert' + (kind === 'err' ? ' alert-error' : '');
      host.textContent = text;
      host.style.display = 'block';
    }

    async function flipAlias(aliasName) {
      const sel = document.querySelector('select[data-alias="' + CSS.escape(aliasName) + '"]');
      const btn = document.querySelector('button[data-alias="' + CSS.escape(aliasName) + '"]');
      const target = sel.value;
      const current = state.aliases.find(a => a.name === aliasName)?.target;
      if (target === current) { showToast(aliasName, 'info', 'Already pointing there.'); return; }

      let auth = getAuth();
      if (!auth) { auth = await promptAuth(); if (!auth) return; setAuth(auth); }

      btn.disabled = true;
      showToast(aliasName, 'info', state.orchestrationEnabled
        ? 'Stopping old container and starting new one. This can take a minute…'
        : 'Flipping alias…');

      const doFetch = (a) => fetch('/admin/aliases/' + encodeURIComponent(aliasName), {
        method: 'PUT', headers: { 'Content-Type': 'application/json', ...authHeader(a) }, body: JSON.stringify({ target })
      });

      try {
        let res = await doFetch(auth);
        if (res.status === 401) {
          clearAuthCreds();
          auth = await promptAuth();
          if (!auth) { btn.disabled = false; showToast(aliasName, 'err', 'Cancelled.'); return; }
          setAuth(auth);
          res = await doFetch(auth);
        }
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          showToast(aliasName, 'err', 'Failed: ' + ((body && body.error && body.error.message) || ('HTTP ' + res.status)));
          return;
        }
        const body = await res.json();
        showToast(aliasName, 'info', 'Switched to ' + body.target + '.');
        await loadAliases();
      } catch (err) {
        showToast(aliasName, 'err', 'Network error: ' + err.message);
      } finally {
        btn.disabled = false;
      }
    }

    loadModels();
    loadAliases();
  </script>
</body>
</html>`;


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
  private orchestrator: ModelOrchestrationService | null = null;

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

    // Seed aliases from config (only inserts new ones; runtime changes are sticky)
    this.db.seedAliases(this.config.aliases ?? []);

    // Clean up old logs
    const deleted = this.db.cleanupOldLogs(this.config.database.retention_days);
    if (deleted > 0) {
      console.log(`🗑️  Cleaned up ${deleted} old usage logs`);
    }

    // Initialize services
    const apiKeyQueries = new ApiKeyQueries(this.db.db);
    const usageQueries = new UsageLogQueries(this.db.db);
    const modelQueries = new ModelConfigQueries(this.db.db);
    const aliasQueries = new ModelAliasQueries(this.db.db);

    this.metricsService = new MetricsService();

    // Initialize scale-to-zero service
    this.scaleToZeroService = new ScaleToZeroService();

    // Orchestrator (only instantiated if any model has a container configured).
    // This is independent from scale-to-zero and used only for alias-flip workflows.
    const hasOrchestratedModel = this.config.models.some((m: any) => !!m.container);
    this.orchestrator = hasOrchestratedModel ? new ModelOrchestrationService() : null;
    if (this.orchestrator) {
      this.orchestrator.register(this.config.models as any);
    }

    const proxyService = new ProxyService(modelQueries, this.scaleToZeroService, aliasQueries);

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
      aliasQueries,
      this.orchestrator,
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

    // Theme stylesheets + picker JS (public, cached).
    this.app.use('/themes', express.static('src/ui/themes', { maxAge: '1h' }));

    // Public mockup previews (kept for reference — pick a theme via the picker).
    this.app.use('/mockups', express.static('src/ui/mockups'));

    // Public read-only model list (used by the landing page)
    this.app.get('/models', (req: Request, res: Response) => {
      const models = modelQueries.listModels().map((m) => ({
        name: m.name,
        cost_per_1k_input: m.costPer1kInput,
        cost_per_1k_output: m.costPer1kOutput,
        orchestrated: this.orchestrator?.hasContainer(m.name) ?? false
      }));
      res.json({ models });
    });

    // Public read-only alias list (used by the landing page)
    this.app.get('/aliases', (req: Request, res: Response) => {
      res.json({
        aliases: aliasQueries.listAliases(),
        orchestrationEnabled: this.orchestrator?.isEnabled() ?? false
      });
    });

    // Root endpoint - landing page with status, models, prices, alias control
    this.app.get('/', (req: Request, res: Response) => {
      const isHtml = req.headers.accept?.includes('text/html');

      if (isHtml) {
        res.setHeader('Content-Type', 'text/html');
        res.send(LANDING_PAGE_HTML);
      } else {
        // JSON response for API clients
        res.json({
          name: 'LLM Proxy',
          status: 'running',
          endpoints: {
            health: '/health',
            admin: '/admin',
            metrics: '/metrics',
            models: '/models',
            aliases: '/aliases',
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

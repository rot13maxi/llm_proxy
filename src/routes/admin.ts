import { Router, type Request, type Response } from 'express';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { ApiKeyQueries, UsageLogQueries, ModelConfigQueries, ModelAliasQueries } from '../db/queries.js';
import { MeteringService } from '../services/metering.js';
import { ModelOrchestrationService } from '../services/orchestrator.js';
import { adminAuthMiddleware } from '../middleware/auth.js';

// Cache UI HTML at module load time (performance optimization)
const UI_PATH = resolve(process.cwd(), 'src/ui/index.html');
const UI_HTML = readFileSync(UI_PATH, 'utf-8');

/**
 * Admin dashboard routes: /admin/*
 * 
 * Endpoints:
 * - GET    /admin           - Web UI
 * - GET    /admin/api       - Dashboard API (JSON)
 * - GET    /admin/keys      - List API keys
 * - POST   /admin/keys      - Create API key
 * - DELETE /admin/keys/:id  - Revoke API key
 * - GET    /admin/models    - List models
 * - GET    /admin/usage     - Usage statistics
 * - GET    /admin/logs      - Recent logs
 */
export function adminRoutes(
  apiKeyQueries: ApiKeyQueries,
  usageQueries: UsageLogQueries,
  modelQueries: ModelConfigQueries,
  aliasQueries: ModelAliasQueries,
  meteringService: MeteringService,
  orchestrator: ModelOrchestrationService | null,
  adminConfig: { username?: string; password?: string; api_key?: string }
) {
  const router = Router();

  // Public: serve the web UI shell (login overlay renders client-side and calls
  // authed APIs below). Must come BEFORE the auth middleware so unauthenticated
  // browsers can load the page and log in.
  router.get('/', (req: Request, res: Response) => {
    res.setHeader('Content-Type', 'text/html');
    res.send(UI_HTML);
  });

  // All admin API routes below this point require auth
  router.use(adminAuthMiddleware(adminConfig));

  // Authed JSON dashboard summary (moved off of GET /)
  router.get('/dashboard', (req: Request, res: Response) => {
    const usage = meteringService.getSystemUsage(1);
    res.json({
      dashboard: {
        today: {
          requests: usage.totalRequests,
          tokens: usage.totalInputTokens + usage.totalOutputTokens,
          cost: usage.totalCost
        },
        week: meteringService.getSystemUsage(7),
        models: modelQueries.listModels()
      }
    });
  });

  // List API keys
  router.get('/keys', (req: Request, res: Response) => {
    const keys = apiKeyQueries.listKeys();
    const keysWithUsage = keys.map(key => {
      const usage = apiKeyQueries.getKeyUsage(key.id, 7);
      return {
        ...key,
        usage: {
          requests: usage.totalRequests,
          tokens: usage.totalInputTokens + usage.totalOutputTokens,
          cost: usage.totalCost
        }
      };
    });

    res.json({ keys: keysWithUsage });
  });

  // Create API key
  router.post('/keys', async (req: Request, res: Response) => {
    try {
      const { name, expiresAt, rateLimitRpm, rateLimitTpm, tags } = req.body;

      if (!name) {
        return res.status(400).json({
          error: { message: 'Name is required', code: 'validation_error' }
        });
      }

      const result = await apiKeyQueries.createKey(
        name,
        expiresAt ? new Date(expiresAt) : undefined,
        rateLimitRpm,
        rateLimitTpm,
        tags
      );

      res.status(201).json({
        id: result.id,
        key: result.key,
        name,
        created_at: new Date().toISOString()
      });

    } catch (error: unknown) {
      console.error('Error creating API key:', error);
      res.status(500).json({
        error: { message: 'Failed to create API key', code: 'internal_error' }
      });
    }
  });

  // Delete API key
  router.delete('/keys/:id', (req: Request, res: Response) => {
    const keyId = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id);
    
    if (isNaN(keyId)) {
      return res.status(400).json({
        error: { message: 'Invalid key ID', code: 'validation_error' }
      });
    }

    const deleted = apiKeyQueries.deleteKey(keyId);

    if (!deleted) {
      return res.status(404).json({
        error: { message: 'API key not found', code: 'not_found' }
      });
    }

    res.status(204).send();
  });

  // Rotate API key
  router.post('/keys/:id/rotate', async (req: Request, res: Response) => {
    const keyId = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id);
    
    if (isNaN(keyId)) {
      return res.status(400).json({
        error: { message: 'Invalid key ID', code: 'validation_error' }
      });
    }

    try {
      const result = await apiKeyQueries.rotateKey(keyId);

      res.status(200).json({
        id: result.id,
        key: result.key,
        message: 'Key rotated successfully. The old key is now invalid.'
      });
    } catch (error: unknown) {
      console.error('Error rotating key:', error);
      res.status(500).json({
        error: { message: 'Failed to rotate API key', code: 'internal_error' }
      });
    }
  });

  // List models
  router.get('/models', (req: Request, res: Response) => {
    const models = modelQueries.listModels();
    res.json({ models });
  });

  // Get usage statistics
  router.get('/usage', (req: Request, res: Response) => {
    const daysParam = Array.isArray(req.query.days) ? req.query.days[0] : req.query.days;
    const days = parseInt(daysParam as string || '7') || 7;
    const usage = meteringService.getSystemUsage(days);
    
    res.json({
      period: days,
      ...usage
    });
  });

  // Get usage for specific API key
  router.get('/keys/:id/usage', (req: Request, res: Response) => {
    const keyId = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id);
    const daysParam = Array.isArray(req.query.days) ? req.query.days[0] : req.query.days;
    const days = parseInt(daysParam as string || '7') || 7;

    if (isNaN(keyId)) {
      return res.status(400).json({
        error: { message: 'Invalid key ID', code: 'validation_error' }
      });
    }

    const usage = meteringService.getKeyUsage(keyId, days);
    res.json(usage);
  });

  // Get metrics with filters (days, model, apiKeyId, tag).
  // Every aggregation (totals, byModel, dailyStats, topApiKeys) respects the
  // same filter so the charts, stats, and top-keys table all agree.
  router.get('/metrics', (req: Request, res: Response) => {
    const param = (k: string) => {
      const v = req.query[k];
      return typeof v === 'string' ? v : Array.isArray(v) ? (typeof v[0] === 'string' ? v[0] : undefined) : undefined;
    };
    const daysParam = param('days');
    const days = parseInt(daysParam || '7') || 7;
    const model = param('model');
    const apiKeyIdRaw = param('apiKeyId');
    const tag = param('tag');

    // Resolve filters to a concrete set of apiKeyIds (or leave undefined for "all")
    let apiKeyIds: number[] | undefined;
    if (apiKeyIdRaw) {
      const keyId = parseInt(apiKeyIdRaw);
      if (isNaN(keyId)) {
        return res.status(400).json({ error: { message: 'Invalid API key ID', code: 'validation_error' } });
      }
      apiKeyIds = [keyId];
    }
    if (tag) {
      const matching = apiKeyQueries.listKeys().filter(k =>
        k.tags && k.tags.split(',').map(t => t.trim()).includes(tag)
      ).map(k => k.id);
      // Intersect with any existing apiKeyId filter
      apiKeyIds = apiKeyIds ? apiKeyIds.filter(id => matching.includes(id)) : matching;
    }

    const filters = { model: model || undefined, apiKeyIds };
    const usage = meteringService.getSystemUsage(days, filters);
    const dailyStats = usageQueries.getDailyStats(days, filters);
    const topApiKeys = usageQueries.getTopApiKeysBySpend(days, 10, filters);

    res.json({
      period: days,
      filters: { model: model || null, apiKeyId: apiKeyIdRaw || null, tag: tag || null },
      summary: {
        totalRequests: usage.totalRequests,
        totalInputTokens: usage.totalInputTokens,
        totalOutputTokens: usage.totalOutputTokens,
        totalCost: usage.totalCost
      },
      byModel: usage.byModel,
      dailyStats,
      topApiKeys
    });
  });

  // Get distinct API keys for filter dropdown
  router.get('/filters/api-keys', (req: Request, res: Response) => {
    const keys = apiKeyQueries.listKeys();
    res.json({ keys: keys.map(k => ({ id: k.id, name: k.name, tags: k.tags })) });
  });

  // Get distinct models for filter dropdown
  router.get('/filters/models', (req: Request, res: Response) => {
    const models = modelQueries.listModels();
    res.json({ models: models.map(m => m.name) });
  });

  // Get hourly stats (for last hour view)
  router.get('/metrics/hourly', (req: Request, res: Response) => {
    const hoursParam = Array.isArray(req.query.hours) ? req.query.hours[0] : req.query.hours;
    const hours = parseInt(hoursParam as string || '1') || 1;
    const model = Array.isArray(req.query.model) ? req.query.model[0] : req.query.model;
    
    // For now, just get all hourly stats (model filter would require more complex query)
    const hourlyStats = usageQueries.getHourlyStats(hours);
    
    res.json({
      period: hours,
      type: 'hourly',
      hourlyStats
    });
  });

  // Get recent logs
  router.get('/logs', (req: Request, res: Response) => {
    const limitParam = Array.isArray(req.query.limit) ? req.query.limit[0] : req.query.limit;
    const limit = parseInt(limitParam as string || '100') || 100;
    const logs = usageQueries.getRecentLogs(limit);

    res.json({ logs });
  });

  // List aliases and their current targets
  router.get('/aliases', (req: Request, res: Response) => {
    const aliases = aliasQueries.listAliases();
    const models = modelQueries.listModels().map((m) => ({
      name: m.name,
      orchestrated: orchestrator?.hasContainer(m.name) ?? false
    }));
    res.json({
      aliases,
      availableTargets: models,
      orchestrationEnabled: orchestrator?.isEnabled() ?? false
    });
  });

  // Retarget an alias. If orchestration is configured on the old or new target,
  // this also flips the containers (stop old, start new, wait for health).
  router.put('/aliases/:name', async (req: Request, res: Response) => {
    const name = Array.isArray(req.params.name) ? req.params.name[0] : req.params.name;
    const target = typeof req.body?.target === 'string' ? req.body.target : undefined;
    if (!target) {
      return res.status(400).json({ error: { message: 'target is required', code: 'validation_error' } });
    }

    const alias = aliasQueries.getAlias(name);
    if (!alias) {
      return res.status(404).json({ error: { message: `Alias not found: ${name}`, code: 'not_found' } });
    }

    const newTarget = modelQueries.getModel(target);
    if (!newTarget) {
      return res.status(400).json({
        error: { message: `Unknown target model: ${target}`, code: 'validation_error' }
      });
    }

    if (alias.target === target) {
      return res.json({ name, target, unchanged: true });
    }

    const previousTarget = alias.target;

    // Flip containers first (orchestration is a no-op when no containers configured).
    // If the new container fails to come up, we leave the alias pointing at the old
    // target so clients aren't routed to something broken.
    let orchestration: { stopped?: string; started?: string; healthy: boolean } = { healthy: true };
    if (orchestrator) {
      try {
        orchestration = await orchestrator.flip(previousTarget, target);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'orchestration failed';
        return res.status(502).json({ error: { message, code: 'orchestration_error' } });
      }
      if (!orchestration.healthy) {
        return res.status(504).json({
          error: {
            message: `${target} did not become healthy within the start timeout; alias not flipped`,
            code: 'orchestration_timeout'
          },
          orchestration
        });
      }
    }

    aliasQueries.setAliasTarget(name, target);
    return res.json({
      name,
      target,
      previousTarget,
      orchestration
    });
  });

  return router;
}

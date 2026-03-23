import { Router, type Request, type Response } from 'express';
import { readFileSync } from 'fs';
import { join, resolve } from 'path';
import { ApiKeyQueries, UsageLogQueries, ModelConfigQueries } from '../db/queries.js';
import { MeteringService } from '../services/metering.js';

// Path to UI file (relative to project root)
const UI_PATH = resolve(process.cwd(), 'src/ui/index.html');

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
  meteringService: MeteringService
) {
  const router = Router();

  // Serve web UI
  router.get('/', (req: Request, res: Response) => {
    // Check if client wants JSON (API client) or HTML (browser)
    const accept = req.headers.accept;
    if (accept && (accept.includes('application/json') || accept.includes('application/problem+json'))) {
      // Return JSON for API clients
      const usage = meteringService.getSystemUsage(1);
      return res.json({
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
    }
    
    // Serve HTML UI for browsers
    try {
      const html = readFileSync(UI_PATH, 'utf-8');
      res.setHeader('Content-Type', 'text/html');
      res.send(html);
    } catch (err) {
      console.error('Error serving UI:', err);
      res.status(500).json({ error: 'Failed to load UI' });
    }
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

  // Get metrics with filters
  router.get('/metrics', (req: Request, res: Response) => {
    const daysParam = Array.isArray(req.query.days) ? req.query.days[0] : req.query.days;
    const days = parseInt(daysParam as string || '7') || 7;
    const model = Array.isArray(req.query.model) ? req.query.model[0] : req.query.model;
    const apiKeyId = req.query.apiKeyId ? String(req.query.apiKeyId) : undefined;

    let usage;
    let byModel;
    if (apiKeyId) {
      const keyId = parseInt(apiKeyId);
      if (isNaN(keyId)) {
        return res.status(400).json({
          error: { message: 'Invalid API key ID', code: 'validation_error' }
        });
      }
      usage = meteringService.getKeyUsage(keyId, days);
      // Get byModel separately for filtered queries
      byModel = usageQueries.getUsageByModel(days);
    } else {
      usage = meteringService.getSystemUsage(days);
      byModel = usage.byModel;
    }

    // Get daily breakdown for charts
    const dailyStats = usageQueries.getUsageByModel(days);
    
    res.json({
      period: days,
      filters: { model, apiKeyId },
      summary: {
        totalRequests: usage.totalRequests,
        totalInputTokens: usage.totalInputTokens,
        totalOutputTokens: usage.totalOutputTokens,
        totalCost: usage.totalCost
      },
      byModel,
      dailyStats
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

  // Health check
  router.get('/health', (req: Request, res: Response) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  return router;
}

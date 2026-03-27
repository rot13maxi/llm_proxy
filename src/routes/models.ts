import { Router, type Request, type Response } from 'express';
import { ModelConfigQueries } from '../db/queries.js';

/**
 * Models endpoint: GET /v1/models
 *
 * Returns OpenAI format by default.
 * Returns Anthropic format when the `anthropic-version` header is present.
 */
export function modelsRoutes(modelQueries: ModelConfigQueries) {
  const router = Router();

  router.get('/models', (_req: Request, res: Response) => {
    const models = modelQueries.listModels();

    if (_req.headers['anthropic-version']) {
      // Anthropic format
      const data = models.map(m => ({
        type: 'model',
        id: m.name,
        display_name: m.name,
        created_at: new Date(0).toISOString(),
      }));
      return res.json({
        data,
        has_more: false,
        first_id: data[0]?.id ?? null,
        last_id: data[data.length - 1]?.id ?? null,
      });
    }

    // OpenAI format
    const data = models.map(m => ({
      id: m.name,
      object: 'model',
      created: 0,
      owned_by: 'system',
    }));
    return res.json({ object: 'list', data });
  });

  return router;
}

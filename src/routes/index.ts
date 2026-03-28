import { Router } from 'express';
import { openaiRoutes } from './openai.js';
import { anthropicRoutes } from './anthropic.js';
import { adminRoutes } from './admin.js';
import { modelsRoutes } from './models.js';
import { ProxyService, MeteringService, MetricsService, ModelAliasService } from '../services/index.js';
import { ApiKeyQueries, UsageLogQueries, ModelConfigQueries, ModelAliasQueries } from '../db/queries.js';

/**
 * Route aggregator - combines all route handlers
 */
export function createRoutes(
  proxyService: ProxyService,
  meteringService: MeteringService,
  metricsService: MetricsService,
  apiKeyQueries: ApiKeyQueries,
  usageQueries: UsageLogQueries,
  modelQueries: ModelConfigQueries,
  adminConfig: { username?: string; password?: string; api_key?: string },
  modelAliasService?: ModelAliasService,
  modelAliasQueries?: ModelAliasQueries
) {
  const router = Router();

  // Models listing endpoint (OpenAI + Anthropic compatible)
  router.use('/v1', modelsRoutes(modelQueries));

  // OpenAI-compatible endpoint
  router.use('/v1', openaiRoutes(proxyService, meteringService, metricsService));

  // Anthropic-compatible endpoint
  router.use('/v1', anthropicRoutes(proxyService, meteringService, metricsService));

  // Admin dashboard
  router.use('/admin', adminRoutes(apiKeyQueries, usageQueries, modelQueries, meteringService, adminConfig, modelAliasService, modelAliasQueries));

  return router;
}

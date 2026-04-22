import { Router } from 'express';
import { openaiRoutes } from './openai.js';
import { anthropicRoutes } from './anthropic.js';
import { adminRoutes } from './admin.js';
import { ProxyService, MeteringService, MetricsService, ModelOrchestrationService } from '../services/index.js';
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
  aliasQueries: ModelAliasQueries,
  orchestrator: ModelOrchestrationService | null,
  adminConfig: { username?: string; password?: string; api_key?: string }
) {
  const router = Router();

  // OpenAI-compatible endpoint
  router.use('/v1', openaiRoutes(proxyService, meteringService, metricsService));

  // Anthropic-compatible endpoint
  router.use('/v1', anthropicRoutes(proxyService, meteringService, metricsService));

  // Admin dashboard
  router.use('/admin', adminRoutes(apiKeyQueries, usageQueries, modelQueries, aliasQueries, meteringService, orchestrator, adminConfig));

  return router;
}

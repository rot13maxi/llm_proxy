import { Router, type Request, type Response } from 'express';
import { ProxyService } from '../services/proxy.js';
import { MeteringService } from '../services/metering.js';
import { MetricsService } from '../services/metrics.js';

/**
 * Anthropic-compatible endpoint: /v1/messages
 * 
 * Translates Anthropic format to OpenAI and back
 */
export function anthropicRoutes(
  proxyService: ProxyService,
  meteringService: MeteringService,
  metricsService: MetricsService
) {
  const router = Router();

  router.post('/messages', async (req: Request & { apiKey?: { id: number } }, res: Response) => {
    const apiKeyId = req.apiKey?.id;
    
    if (!apiKeyId) {
      return res.status(401).json({
        error: { message: 'Unauthorized', code: 'unauthorized' }
      });
    }

    // Validate request body
    if (!req.body.model) {
      return res.status(400).json({
        error: { message: 'model is required', code: 'invalid_request_error' }
      });
    }

    if (!req.body.messages || !Array.isArray(req.body.messages)) {
      return res.status(400).json({
        error: { message: 'messages array is required', code: 'invalid_request_error' }
      });
    }

    const model = req.body.model;

    try {
      const result = await proxyService.proxyAnthropic(model, req.body, apiKeyId);

      res.json(result.response);

      // Log usage
      meteringService.logUsage({
        apiKeyId,
        model,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        latencyMs: result.latencyMs,
        statusCode: result.statusCode
      });

      metricsService.recordRequest(
        '/v1/messages',
        result.statusCode.toString(),
        model,
        result.latencyMs,
        0,
        result.usage.inputTokens,
        result.usage.outputTokens
      );

    } catch (error: unknown) {
      const err = error as Error;
      
      if (err.message.includes('Model not found')) {
        return res.status(404).json({
          error: {
            message: `Model not found: ${model}`,
            code: 'model_not_found'
          }
        });
      }

      console.error('Anthropic proxy error:', err);
      res.status(502).json({
        error: {
          message: 'Upstream error',
          code: 'upstream_error'
        }
      });

      // Log failed request only if model is configured
      try {
        if (model && model !== 'unknown') {
          meteringService.logUsage({
            apiKeyId,
            model,
            inputTokens: 0,
            outputTokens: 0,
            latencyMs: 0,
            statusCode: 502
          });
        }
      } catch (logError) {
        console.error('Failed to log usage:', logError);
      }
    }
  });

  return router;
}

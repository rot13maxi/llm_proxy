import { Router, type Request, type Response } from 'express';
import { ProxyService } from '../services/proxy.js';
import { MeteringService } from '../services/metering.js';
import { MetricsService } from '../services/metrics.js';

/**
 * OpenAI-compatible endpoint: /v1/chat/completions
 * 
 * Supports both streaming and non-streaming responses
 */
export function openaiRoutes(
  proxyService: ProxyService,
  meteringService: MeteringService,
  metricsService: MetricsService
) {
  const router = Router();

  router.post('/chat/completions', async (req: Request & { apiKey?: { id: number } }, res: Response) => {
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
    const stream = req.body.stream === true;

    try {
      if (stream) {
        // Handle streaming - let proxy service set headers
        const result = await proxyService.proxyOpenAIStream(
          model,
          req.body,
          res,
          apiKeyId
        );

        // Log usage after stream completes
        meteringService.logUsage({
          apiKeyId,
          model,
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          latencyMs: result.latencyMs,
          statusCode: result.statusCode
        });

        metricsService.recordRequest(
          '/v1/chat/completions',
          result.statusCode.toString(),
          model,
          result.latencyMs,
          0, // Cost calculated in metering
          result.usage.inputTokens,
          result.usage.outputTokens
        );

      } else {
        // Handle non-streaming
        const result = await proxyService.proxyOpenAI(model, req.body, apiKeyId);

        // Log usage before sending response
        try {
          meteringService.logUsage({
            apiKeyId,
            model,
            inputTokens: result.usage.inputTokens,
            outputTokens: result.usage.outputTokens,
            latencyMs: result.latencyMs,
            statusCode: result.statusCode
          });

          metricsService.recordRequest(
            '/v1/chat/completions',
            result.statusCode.toString(),
            model,
            result.latencyMs,
            0,
            result.usage.inputTokens,
            result.usage.outputTokens
          );
        } catch (logError) {
          console.error('Failed to log usage:', logError);
        }

        res.status(result.statusCode).json(result.response);
      }
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

      console.error('OpenAI proxy error:', err);
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

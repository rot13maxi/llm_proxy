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

    // Fire-and-forget usage accounting — never block the response on SQLite writes,
    // key-name lookups, or the WebSocket broadcast. Runs after the current tick
    // via setImmediate so the response has already flushed to the socket.
    const recordUsage = (resolvedModel: string, inputTokens: number, outputTokens: number, latencyMs: number, statusCode: number) => {
      setImmediate(() => {
        try {
          meteringService.logUsage({ apiKeyId, model: resolvedModel, inputTokens, outputTokens, latencyMs, statusCode });
          const cost = meteringService.calculateCost(resolvedModel, inputTokens, outputTokens);
          metricsService.recordRequest('/v1/chat/completions', statusCode.toString(), resolvedModel, latencyMs, cost, inputTokens, outputTokens);
        } catch (logError) {
          console.error('Failed to log usage:', logError);
        }
      });
    };

    try {
      if (stream) {
        // Handle streaming - let proxy service set headers + write body
        const result = await proxyService.proxyOpenAIStream(model, req.body, res, apiKeyId);
        recordUsage(result.resolvedModel, result.usage.inputTokens, result.usage.outputTokens, result.latencyMs, result.statusCode);

      } else {
        // Handle non-streaming — send response FIRST, then record usage.
        const result = await proxyService.proxyOpenAI(model, req.body, apiKeyId);
        res.status(result.statusCode).json(result.response);
        recordUsage(result.resolvedModel, result.usage.inputTokens, result.usage.outputTokens, result.latencyMs, result.statusCode);
      }
    } catch (error: unknown) {
      // Skip error response if headers already sent (stream failures handled by proxy)
      if (res.headersSent) {
        return;
      }

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

      // Log failed request asynchronously — don't delay the error response
      if (model && model !== 'unknown') {
        setImmediate(() => {
          try {
            meteringService.logUsage({ apiKeyId, model, inputTokens: 0, outputTokens: 0, latencyMs: 0, statusCode: 502 });
          } catch (logError) {
            console.error('Failed to log usage:', logError);
          }
        });
      }
    }
  });

  return router;
}

import * as http from 'http';
import * as https from 'https';
import { URL } from 'url';
import { Transformer, type OpenAIRequest, type OpenAIResponse, type OpenAIStreamChunk } from './transformer.js';
import { type ModelConfigQueries } from '../db/queries.js';
import { ScaleToZeroService } from './scaleToZero.js';

/**
 * Proxy Service - forwards requests to upstream LLM servers
 * 
 * Flow:
 * ┌─────────────┐    ┌─────────────┐    ┌─────────────┐    ┌─────────────┐
 * │  Client     │───▶│  Proxy      │───▶│  Transform  │───▶│  Upstream   │
 * │  Request    │    │  Handler    │    │  Format     │    │  (sglang)   │
 * └─────────────┘    └─────────────┘    └─────────────┘    └─────────────┘
      │                   │                   │                   │
      │                   │  1. Check readiness (scale-to-zero) │
      │                   │  2. Get model config                │
      │                   │  3. Build upstream URL             │
      │                   │  4. Forward request                │
      │                   │  5. Stream/response back           │
      │                   │  6. Extract usage                  │
      │                   │  7. Reset idle timer               │
      └───────────────────┴─────────────────────────────────────┘
 */
export class ProxyService {
  private transformer = new Transformer();
  private agentHttp: http.Agent;
  private agentHttps: https.Agent;

  constructor(
    private modelQueries: ModelConfigQueries,
    private scaleToZeroService?: ScaleToZeroService
  ) {
    // Reuse connections for performance
    this.agentHttp = new http.Agent({ keepAlive: true, maxFreeSockets: 50 });
    this.agentHttps = new https.Agent({ keepAlive: true, maxFreeSockets: 50 });
  }

  /**
   * Initialize scale-to-zero for models that have it configured
   */
  initScaleToZero(models: Array<{
    name: string;
    scale_to_zero?: {
      enabled: boolean;
      container_name?: string;
      backend_port?: number;
      idle_timeout_minutes: number;
      start_timeout_seconds: number;
      health_check_path: string;
      health_check_interval_ms: number;
    };
  }>): void {
    if (!this.scaleToZeroService) return;

    for (const model of models) {
      const stz = model.scale_to_zero;
      if (stz?.enabled && stz.container_name) {
        this.scaleToZeroService.init(model.name, {
          containerName: stz.container_name,
          backendPort: stz.backend_port || 8000,
          idleTimeoutMinutes: stz.idle_timeout_minutes,
          startTimeoutSeconds: stz.start_timeout_seconds,
          healthCheckPath: stz.health_check_path,
          healthCheckIntervalMs: stz.health_check_interval_ms
        });
      }
    }
  }

  /**
   * Check if model is ready, start if necessary
   * Returns { ready: boolean, started: boolean }
   */
  private async ensureReady(model: string): Promise<{ ready: boolean; started: boolean }> {
    if (!this.scaleToZeroService) {
      return { ready: true, started: false };
    }

    const isReady = await this.scaleToZeroService.isReady(model);
    if (isReady) {
      return { ready: true, started: false };
    }

    // Try to start
    const started = await this.scaleToZeroService.start(model);
    const nowReady = await this.scaleToZeroService.isReady(model);
    
    return { ready: nowReady, started };
  }

  /**
   * Proxy an OpenAI-compatible request
   */
  async proxyOpenAI(
    model: string,
    requestBody: OpenAIRequest,
    apiKeyId: number
  ): Promise<{
    response: OpenAIResponse;
    usage: { inputTokens: number; outputTokens: number };
    latencyMs: number;
    statusCode: number;
  }> {
    const startTime = Date.now();
    const modelConfig = this.modelQueries.getModel(model);

    if (!modelConfig) {
      throw new Error(`Model not found: ${model}`);
    }

    // Check readiness and start if needed
    const { ready } = await this.ensureReady(model);
    if (!ready) {
      return {
        response: {
          id: '',
          choices: [],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          created: 0,
          model,
          error: 'Service temporarily unavailable. Backend is starting up.'
        } as OpenAIResponse,
        usage: { inputTokens: 0, outputTokens: 0 },
        latencyMs: Date.now() - startTime,
        statusCode: 503
      };
    }

    const { response, statusCode } = await this.forwardRequest(modelConfig.upstream, requestBody);
    const latencyMs = Date.now() - startTime;

    // Reset idle timer on successful request
    if (statusCode < 400) {
      this.scaleToZeroService?.resetIdleTimer(model);
    }

    const usage = this.transformer.extractUsage(response);

    return {
      response,
      usage,
      latencyMs,
      statusCode
    };
  }

  /**
   * Proxy an OpenAI-compatible streaming request
   * Returns a readable stream
   */
  proxyOpenAIStream(
    model: string,
    requestBody: OpenAIRequest,
    response: any,
    apiKeyId: number
  ): Promise<{
    usage: { inputTokens: number; outputTokens: number };
    latencyMs: number;
    statusCode: number;
  }> {
    const startTime = Date.now();
    const modelConfig = this.modelQueries.getModel(model);

    if (!modelConfig) {
      throw new Error(`Model not found: ${model}`);
    }

    // Check readiness before starting stream
    return this.ensureReady(model).then(({ ready }) => {
      if (!ready) {
        if (!response.headersSent) {
          response.writeHead(503, { 'Content-Type': 'application/json' });
          response.end(JSON.stringify({ error: 'Service temporarily unavailable. Backend is starting up.' }));
        }
        return Promise.resolve({
          usage: { inputTokens: 0, outputTokens: 0 },
          latencyMs: Date.now() - startTime,
          statusCode: 503
        });
      }

      return new Promise((resolve, reject) => {
        const { req, bodyStr } = this.createUpstreamRequest(modelConfig.upstream, requestBody);
        let streamSucceeded = false;

        req.on('response', (upstreamRes) => {
          response.writeHead(upstreamRes.statusCode!, upstreamRes.headers);
          
          // Track usage from final chunk
          let finalUsage: { inputTokens: number; outputTokens: number } = { inputTokens: 0, outputTokens: 0 };

          upstreamRes.on('data', (chunk: Buffer) => {
            // Pass through to client
            response.write(chunk);

            // Try to extract usage from chunk
            try {
              const text = chunk.toString();
              const lines = text.split('\n\n');
              for (const line of lines) {
                if (line.startsWith('data: ')) {
                  const data = JSON.parse(line.slice(6));
                  if (data.usage) {
                    finalUsage = this.transformer.extractUsage(data);
                  }
                }
              }
            } catch {
              // Ignore parse errors
            }
          });

          upstreamRes.on('end', () => {
            response.end();
            streamSucceeded = true;
            const latencyMs = Date.now() - startTime;
            resolve({
              usage: finalUsage,
              latencyMs,
              statusCode: upstreamRes.statusCode!
            });
          });
        });

        req.on('error', (err) => {
          if (!response.headersSent) {
            response.writeHead(502, { 'Content-Type': 'application/json' });
            response.end(JSON.stringify({ error: err.message }));
            resolve({
              usage: { inputTokens: 0, outputTokens: 0 },
              latencyMs: Date.now() - startTime,
              statusCode: 502
            });
          } else {
            reject(err);
          }
        });

        req.end(bodyStr);

        // Reset idle timer after stream completes successfully
        // We do this in the resolve callback above when streamSucceeded is true
        Promise.resolve().then(() => {
          if (streamSucceeded) {
            this.scaleToZeroService?.resetIdleTimer(model);
          }
        });
      });
    });
  }

  /**
   * Proxy an Anthropic-compatible request
   */
  async proxyAnthropic(
    model: string,
    requestBody: any,
    apiKeyId: number
  ): Promise<{
    response: any;
    usage: { inputTokens: number; outputTokens: number };
    latencyMs: number;
    statusCode: number;
  }> {
    const startTime = Date.now();
    
    // Transform to OpenAI format
    const openAIRequest = this.transformer.anthropicToOpenAI(requestBody);
    
    // Forward to upstream
    const result = await this.proxyOpenAI(model, openAIRequest, apiKeyId);
    
    // Propagate error responses directly without transformation
    if (result.statusCode >= 400) {
      return {
        response: result.response,
        usage: result.usage,
        latencyMs: result.latencyMs,
        statusCode: result.statusCode
      };
    }
    
    // Transform response back to Anthropic format
    const anthropicResponse = this.transformer.openAIToAnthropic(result.response);

    return {
      response: anthropicResponse,
      usage: result.usage,
      latencyMs: result.latencyMs,
      statusCode: result.statusCode
    };
  }

  private readonly maxResponseSize = 10 * 1024 * 1024;

  /**
   * Forward request to upstream server
   */
  private forwardRequest(
    upstreamUrl: string,
    body: object
  ): Promise<{ response: OpenAIResponse; statusCode: number }> {
    return new Promise((resolve, reject) => {
      const { req, bodyStr } = this.createUpstreamRequest(upstreamUrl, body);
      let data = '';
      let totalSize = 0;

      req.on('response', (res) => {
        res.on('data', (chunk: Buffer) => {
          const chunkSize = chunk.length;
          totalSize += chunkSize;

          if (totalSize > this.maxResponseSize) {
            req.destroy();
            reject(new Error(`Response size exceeds limit of ${this.maxResponseSize / (1024 * 1024)}MB. Use streaming for large responses.`));
            return;
          }

          data += chunk.toString();
        });

        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            resolve({ response: json as OpenAIResponse, statusCode: res.statusCode! });
          } catch (err) {
            reject(new Error(`Failed to parse response: ${err}`));
          }
        });
      });

      req.on('error', (err) => {
        reject(err);
      });

      req.end(bodyStr);
    });
  }

  /**
   * Create upstream HTTP request
   */
  private createUpstreamRequest(upstreamUrl: string, body: object): { req: http.ClientRequest; bodyStr: string } {
    const url = new URL(upstreamUrl);
    const isHttps = url.protocol === 'https:';
    const agent = isHttps ? this.agentHttps : this.agentHttp;
    const lib = isHttps ? https : http;

    // Serialize body once (performance optimization)
    const bodyStr = JSON.stringify(body);

    const req = lib.request({
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(bodyStr)
      },
      agent
    });

    return { req, bodyStr };
  }
}

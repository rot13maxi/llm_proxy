import * as http from 'http';
import * as https from 'https';
import { URL } from 'url';
import { Transformer, type OpenAIRequest, type OpenAIResponse } from './transformer.js';
import { type ModelConfigQueries, type ModelAliasQueries } from '../db/queries.js';
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
    private scaleToZeroService?: ScaleToZeroService,
    private aliasQueries?: ModelAliasQueries
  ) {
    // Reuse connections for performance
    this.agentHttp = new http.Agent({ keepAlive: true, maxFreeSockets: 50 });
    this.agentHttps = new https.Agent({ keepAlive: true, maxFreeSockets: 50 });
  }

  /**
   * Resolve an alias to its concrete model target. If `name` isn't an alias,
   * returns `name` unchanged. Non-alias names that don't match any model are
   * returned as-is so the caller can surface the usual "model not found" error.
   */
  resolveModel(name: string): { modelName: string; aliasFrom?: string } {
    if (!this.aliasQueries) return { modelName: name };
    const alias = this.aliasQueries.getAlias(name);
    if (!alias) return { modelName: name };
    return { modelName: alias.target, aliasFrom: alias.name };
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
    resolvedModel: string;
  }> {
    const startTime = Date.now();
    const { modelName: resolvedModel } = this.resolveModel(model);
    const modelConfig = this.modelQueries.getModel(resolvedModel);

    if (!modelConfig) {
      throw new Error(`Model not found: ${model}`);
    }

    // Check readiness and start if needed (uses resolved target)
    const { ready } = await this.ensureReady(resolvedModel);
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
        statusCode: 503,
        resolvedModel
      };
    }

    const { response, statusCode } = await this.forwardRequest(modelConfig.upstream, requestBody);
    const latencyMs = Date.now() - startTime;

    // Reset idle timer on successful request (keyed on resolved model)
    if (statusCode < 400) {
      this.scaleToZeroService?.resetIdleTimer(resolvedModel);
    }

    const usage = this.transformer.extractUsage(response);

    return {
      response,
      usage,
      latencyMs,
      statusCode,
      resolvedModel
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
    resolvedModel: string;
  }> {
    const startTime = Date.now();
    const { modelName: resolvedModel } = this.resolveModel(model);
    const modelConfig = this.modelQueries.getModel(resolvedModel);

    if (!modelConfig) {
      throw new Error(`Model not found: ${model}`);
    }

    // Check readiness before starting stream (uses resolved target)
    return this.ensureReady(resolvedModel).then(({ ready }) => {
      if (!ready) {
        if (!response.headersSent) {
          response.writeHead(503, { 'Content-Type': 'application/json' });
          response.end(JSON.stringify({ error: 'Service temporarily unavailable. Backend is starting up.' }));
        }
        return Promise.resolve({
          usage: { inputTokens: 0, outputTokens: 0 },
          latencyMs: Date.now() - startTime,
          statusCode: 503,
          resolvedModel
        });
      }

      return new Promise((resolve, reject) => {
        // Force upstream to include usage stats in the final SSE chunk.
        // Many OpenAI-compatible servers (sglang, vllm) only emit usage when
        // stream_options.include_usage is true; without this streaming requests
        // get metered as 0 tokens.
        const upstreamBody: OpenAIRequest & { stream_options?: { include_usage: boolean } } = {
          ...requestBody,
          stream: true,
          stream_options: { ...(requestBody as any).stream_options, include_usage: true }
        };
        const { req, bodyStr } = this.createUpstreamRequest(modelConfig.upstream, upstreamBody);
        let streamSucceeded = false;

        req.on('response', (upstreamRes) => {
          response.writeHead(upstreamRes.statusCode!, upstreamRes.headers);

          // Track usage - final chunk wins (SSE-compliant parsing with line buffer
          // because usage chunks can straddle TCP read boundaries).
          let finalUsage: { inputTokens: number; outputTokens: number } = { inputTokens: 0, outputTokens: 0 };
          let buffer = '';

          const processEvent = (event: string) => {
            // An SSE event is a block of lines separated by \n; we only care about `data:` lines
            for (const line of event.split(/\r?\n/)) {
              if (!line.startsWith('data:')) continue;
              const payload = line.slice(5).trimStart();
              if (!payload || payload === '[DONE]') continue;
              try {
                const data = JSON.parse(payload);
                if (data.usage) {
                  finalUsage = this.transformer.extractUsage(data);
                }
              } catch {
                // Partial JSON or unrelated data line - ignore
              }
            }
          };

          upstreamRes.on('data', (chunk: Buffer) => {
            // Pass through to client unchanged
            response.write(chunk);

            buffer += chunk.toString('utf8');
            // SSE events are separated by a blank line (\n\n or \r\n\r\n).
            // Split on event boundaries, keep any trailing partial event in the buffer.
            let sepIdx: number;
            while ((sepIdx = buffer.search(/\r?\n\r?\n/)) !== -1) {
              const event = buffer.slice(0, sepIdx);
              const match = buffer.slice(sepIdx).match(/^\r?\n\r?\n/)!;
              buffer = buffer.slice(sepIdx + match[0].length);
              processEvent(event);
            }
          });

          upstreamRes.on('end', () => {
            // Flush any remaining buffered event (servers sometimes omit trailing \n\n)
            if (buffer.trim().length > 0) {
              processEvent(buffer);
              buffer = '';
            }
            response.end();
            streamSucceeded = true;
            const latencyMs = Date.now() - startTime;
            resolve({
              usage: finalUsage,
              latencyMs,
              statusCode: upstreamRes.statusCode!,
              resolvedModel
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
              statusCode: 502,
              resolvedModel
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
            this.scaleToZeroService?.resetIdleTimer(resolvedModel);
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
    resolvedModel: string;
  }> {
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
        statusCode: result.statusCode,
        resolvedModel: result.resolvedModel
      };
    }

    // Transform response back to Anthropic format
    const anthropicResponse = this.transformer.openAIToAnthropic(result.response);

    return {
      response: anthropicResponse,
      usage: result.usage,
      latencyMs: result.latencyMs,
      statusCode: result.statusCode,
      resolvedModel: result.resolvedModel
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

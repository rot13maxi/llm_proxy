import * as http from 'http';
import * as https from 'https';
import { URL } from 'url';
import { Transformer, type OpenAIRequest, type OpenAIResponse, type OpenAIStreamChunk } from './transformer.js';
import { type ModelConfigQueries } from '../db/queries.js';

/**
 * Proxy Service - forwards requests to upstream LLM servers
 * 
 * Flow:
 * ┌─────────────┐    ┌─────────────┐    ┌─────────────┐    ┌─────────────┐
 * │  Client     │───▶│  Proxy      │───▶│  Transform  │───▶│  Upstream   │
 * │  Request    │    │  Handler    │    │  Format     │    │  (sglang)   │
 * └─────────────┘    └─────────────┘    └─────────────┘    └─────────────┘
      │                   │                   │                   │
      │                   │  1. Get model config                │
      │                   │  2. Build upstream URL             │
      │                   │  3. Forward request                │
      │                   │  4. Stream/response back           │
      │                   │  5. Extract usage                  │
      └───────────────────┴─────────────────────────────────────┘
 */
export class ProxyService {
  private transformer = new Transformer();
  private agentHttp: http.Agent;
  private agentHttps: https.Agent;

  constructor(private modelQueries: ModelConfigQueries) {
    // Reuse connections for performance
    this.agentHttp = new http.Agent({ keepAlive: true, maxFreeSockets: 50 });
    this.agentHttps = new https.Agent({ keepAlive: true, maxFreeSockets: 50 });
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

    const { response, statusCode } = await this.forwardRequest(modelConfig.upstream, requestBody);
    const latencyMs = Date.now() - startTime;

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

    return new Promise((resolve, reject) => {
      const req = this.createUpstreamRequest(modelConfig.upstream, requestBody);

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
        }
        response.end(JSON.stringify({ error: err.message }));
        reject(err);
      });

      req.end(JSON.stringify(requestBody));
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
      const req = this.createUpstreamRequest(upstreamUrl, body);
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

      req.end(JSON.stringify(body));
    });
  }

  /**
   * Create upstream HTTP request
   */
  private createUpstreamRequest(upstreamUrl: string, body: object): http.ClientRequest {
    const url = new URL(upstreamUrl);
    const isHttps = url.protocol === 'https:';
    const agent = isHttps ? this.agentHttps : this.agentHttp;
    const lib = isHttps ? https : http;

    const req = lib.request({
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(JSON.stringify(body))
      },
      agent
    });

    return req;
  }
}

import * as client from 'prom-client';
import type { Request, Response } from 'express';

/**
 * Metrics Service - Prometheus metrics for monitoring
 * 
 * Metrics exposed:
 * - llm_proxy_requests_total: Total requests by endpoint and status
 * - llm_proxy_tokens_total: Total tokens (input/output) by model
 * - llm_proxy_latency_seconds: Request latency histogram
 * - llm_proxy_cost_total: Total cost by model
 * - llm_proxy_api_keys_active: Number of active API keys
 */
export class MetricsService {
  private registry: client.Registry;
  private requestCounter: client.Counter<string>;
  private tokenCounter: client.Counter<string>;
  private latencyHistogram: client.Histogram<string>;
  private costCounter: client.Counter<string>;
  private activeKeysGauge: client.Gauge<string>;

  constructor() {
    this.registry = new client.Registry();
    client.collectDefaultMetrics({ register: this.registry });

    // Request counter
    this.requestCounter = new client.Counter({
      name: 'llm_proxy_requests_total',
      help: 'Total number of requests',
      labelNames: ['endpoint', 'status', 'model'],
      registers: [this.registry]
    });

    // Token counter
    this.tokenCounter = new client.Counter({
      name: 'llm_proxy_tokens_total',
      help: 'Total tokens processed',
      labelNames: ['model', 'type'], // type: input/output
      registers: [this.registry]
    });

    // Latency histogram
    this.latencyHistogram = new client.Histogram({
      name: 'llm_proxy_latency_seconds',
      help: 'Request latency in seconds',
      labelNames: ['endpoint', 'model'],
      buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
      registers: [this.registry]
    });

    // Cost counter
    this.costCounter = new client.Counter({
      name: 'llm_proxy_cost_total',
      help: 'Total cost in USD',
      labelNames: ['model'],
      registers: [this.registry]
    });

    // Active keys gauge
    this.activeKeysGauge = new client.Gauge({
      name: 'llm_proxy_api_keys_active',
      help: 'Number of active API keys',
      registers: [this.registry]
    });
  }

  /**
   * Record a request
   */
  recordRequest(endpoint: string, status: string, model: string, latencyMs: number, cost: number, inputTokens: number, outputTokens: number): void {
    this.requestCounter.inc({ endpoint, status, model });
    this.latencyHistogram.observe({ endpoint, model }, latencyMs / 1000);
    this.costCounter.inc({ model }, cost);
    this.tokenCounter.inc({ model, type: 'input' }, inputTokens);
    this.tokenCounter.inc({ model, type: 'output' }, outputTokens);
  }

  /**
   * Update active API keys count
   */
  setActiveKeys(count: number): void {
    this.activeKeysGauge.set(count);
  }

  /**
   * Get metrics in Prometheus format
   */
  async getMetrics(): Promise<string> {
    return this.registry.metrics();
  }

  /**
   * Get metrics endpoint handler
   */
  getMetricsHandler() {
    return async (req: Request, res: Response) => {
      res.set('Content-Type', this.registry.contentType);
      const metrics = await this.getMetrics();
      res.send(metrics);
    };
  }
}

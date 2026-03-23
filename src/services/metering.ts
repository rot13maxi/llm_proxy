import { UsageLogQueries, ModelConfigQueries, ApiKeyQueries } from '../db/queries.js';

/**
 * Metering Service - calculates costs and tracks usage
 * 
 * Cost Formula:
 * cost = (input_tokens / 1000 * cost_per_1k_input) +
 *        (output_tokens / 1000 * cost_per_1k_output)
 * 
 * Flow:
 * ┌─────────────┐    ┌─────────────┐    ┌─────────────┐
 * │  Usage      │───▶│  Calculate  │───▶│  Log to DB  │
 * │  (tokens)   │    │  Cost       │    │             │
 * └─────────────┘    └─────────────┘    └─────────────┘
 */
export class MeteringService {
  constructor(
    private usageQueries: UsageLogQueries,
    private modelQueries: ModelConfigQueries,
    private apiKeyQueries: ApiKeyQueries
  ) {}

  /**
   * Calculate cost for a request
   */
  calculateCost(model: string, inputTokens: number, outputTokens: number): number {
    const modelConfig = this.modelQueries.getModel(model);
    
    if (!modelConfig) {
      throw new Error(`Model not found: ${model}`);
    }

    const inputCost = (inputTokens / 1000) * modelConfig.costPer1kInput;
    const outputCost = (outputTokens / 1000) * modelConfig.costPer1kOutput;

    return inputCost + outputCost;
  }

  /**
   * Log usage to database
   */
  logUsage(log: {
    apiKeyId: number;
    model: string;
    inputTokens: number;
    outputTokens: number;
    latencyMs: number;
    statusCode: number;
  }): void {
    const cost = this.calculateCost(
      log.model,
      log.inputTokens,
      log.outputTokens
    );

    this.usageQueries.logUsage({
      apiKeyId: log.apiKeyId,
      model: log.model,
      inputTokens: log.inputTokens,
      outputTokens: log.outputTokens,
      latencyMs: log.latencyMs,
      statusCode: log.statusCode,
      costUsd: cost
    });
  }

  /**
   * Get usage summary for an API key
   */
  getKeyUsage(apiKeyId: number, days: number = 7): {
    totalRequests: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalCost: number;
    dailyBreakdown: Array<{
      date: string;
      requests: number;
      inputTokens: number;
      outputTokens: number;
      cost: number;
    }>;
  } {
    const totals = this.apiKeyQueries.getKeyUsage(apiKeyId, days);
    const dailyBreakdown = this.usageQueries.getUsageByApiKey(apiKeyId, days);

    return {
      totalRequests: totals.totalRequests,
      totalInputTokens: totals.totalInputTokens,
      totalOutputTokens: totals.totalOutputTokens,
      totalCost: totals.totalCost,
      dailyBreakdown: dailyBreakdown.map(row => ({
        date: row.date,
        requests: row.requests,
        inputTokens: row.inputTokens,
        outputTokens: row.outputTokens,
        cost: row.cost
      }))
    };
  }

  /**
   * Get system-wide usage
   */
  getSystemUsage(days: number = 7): {
    totalRequests: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalCost: number;
    byModel: Array<{
      model: string;
      requests: number;
      inputTokens: number;
      outputTokens: number;
      cost: number;
    }>;
  } {
    const totals = this.usageQueries.getTotals(days);
    const byModel = this.usageQueries.getUsageByModel(days);

    return {
      totalRequests: totals.totalRequests,
      totalInputTokens: totals.totalInputTokens,
      totalOutputTokens: totals.totalOutputTokens,
      totalCost: totals.totalCost,
      byModel: byModel.map(row => ({
        model: row.model,
        requests: row.requests,
        inputTokens: row.inputTokens,
        outputTokens: row.outputTokens,
        cost: row.cost
      }))
    };
  }
}

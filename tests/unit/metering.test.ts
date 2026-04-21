import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MeteringService } from '../../src/services/metering.js';
import { UsageLogQueries, ModelConfigQueries } from '../../src/db/queries.js';
import type { Database } from 'better-sqlite3';

describe('MeteringService', () => {
  let mockUsageQueries: any;
  let mockModelQueries: any;
  let meteringService: MeteringService;

  beforeEach(() => {
    mockUsageQueries = {
      logUsage: vi.fn(),
      getUsageByApiKey: vi.fn(),
      getUsageByModel: vi.fn(),
      getTotals: vi.fn()
    };

    mockModelQueries = {
      getModel: vi.fn()
    };

    const mockApiKeyQueries = {
      getKeyUsage: vi.fn(),
      listKeys: vi.fn()
    };

    meteringService = new MeteringService(
      mockUsageQueries as UsageLogQueries,
      mockModelQueries as ModelConfigQueries,
      mockApiKeyQueries as any
    );
  });

  describe('calculateCost', () => {
    it('should calculate cost correctly', () => {
      mockModelQueries.getModel.mockReturnValue({
        upstream: 'http://test',
        costPer1kInput: 0.001,
        costPer1kOutput: 0.002
      });

      const cost = meteringService.calculateCost('test-model', 1000, 500);

      // (1000/1000 * 0.001) + (500/1000 * 0.002) = 0.001 + 0.001 = 0.002
      expect(cost).toBe(0.002);
    });

    it('should handle fractional tokens', () => {
      mockModelQueries.getModel.mockReturnValue({
        upstream: 'http://test',
        costPer1kInput: 0.001,
        costPer1kOutput: 0.002
      });

      const cost = meteringService.calculateCost('test-model', 100, 50);

      // (100/1000 * 0.001) + (50/1000 * 0.002) = 0.0001 + 0.0001 = 0.0002
      expect(cost).toBe(0.0002);
    });

    it('should throw error for unknown model', () => {
      mockModelQueries.getModel.mockReturnValue(null);

      expect(() => {
        meteringService.calculateCost('unknown-model', 100, 50);
      }).toThrow('Model not found: unknown-model');
    });
  });

  describe('logUsage', () => {
    it('should log usage with calculated cost', () => {
      mockModelQueries.getModel.mockReturnValue({
        upstream: 'http://test',
        costPer1kInput: 0.001,
        costPer1kOutput: 0.002
      });

      meteringService.logUsage({
        apiKeyId: 1,
        model: 'test-model',
        inputTokens: 1000,
        outputTokens: 500,
        latencyMs: 100,
        statusCode: 200
      });

      expect(mockUsageQueries.logUsage).toHaveBeenCalledWith({
        apiKeyId: 1,
        model: 'test-model',
        inputTokens: 1000,
        outputTokens: 500,
        latencyMs: 100,
        statusCode: 200,
        costUsd: 0.002
      });
    });
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { UsageLogQueries } from '../../src/db/queries.js';
import type { Database } from 'better-sqlite3';

describe('UsageLogQueries', () => {
  let mockDb: any;
  let usageQueries: UsageLogQueries;

  beforeEach(() => {
    mockDb = {
      prepare: vi.fn().mockReturnThis(),
      all: vi.fn(),
      get: vi.fn(),
      run: vi.fn()
    };

    usageQueries = new UsageLogQueries(mockDb as Database);
  });

  describe('getUsageByModelHours', () => {
    it('should return usage by model for last N hours', () => {
      const mockRows = [
        {
          model: 'gpt-4',
          requests: 10,
          input_tokens: 1000,
          output_tokens: 500,
          cost: 0.002
        },
        {
          model: 'gpt-3.5-turbo',
          requests: 20,
          input_tokens: 2000,
          output_tokens: 1000,
          cost: 0.001
        }
      ];

      mockDb.prepare.mockReturnValue({
        all: vi.fn().mockReturnValue(mockRows)
      });

      const result = usageQueries.getUsageByModelHours(24);

      expect(mockDb.prepare).toHaveBeenCalledWith(expect.stringContaining('datetime(\'now\', \'-\' || ? || \' hours\')'));
      expect(result).toEqual([
        {
          model: 'gpt-4',
          requests: 10,
          inputTokens: 1000,
          outputTokens: 500,
          cost: 0.002
        },
        {
          model: 'gpt-3.5-turbo',
          requests: 20,
          inputTokens: 2000,
          outputTokens: 1000,
          cost: 0.001
        }
      ]);
    });

    it('should filter by model when provided', () => {
      const mockRows = [
        {
          model: 'gpt-4',
          requests: 10,
          input_tokens: 1000,
          output_tokens: 500,
          cost: 0.002
        }
      ];

      mockDb.prepare.mockReturnValue({
        all: vi.fn().mockReturnValue(mockRows)
      });

      const result = usageQueries.getUsageByModelHours(24, 'gpt-4');

      expect(mockDb.prepare).toHaveBeenCalledWith(expect.stringContaining('model = ?'));
      expect(result).toHaveLength(1);
      expect(result[0].model).toBe('gpt-4');
    });

    it('should default to 1 hour when no hours parameter provided', () => {
      const mockPrepare = vi.fn().mockReturnValue({
        all: vi.fn().mockReturnValue([])
      });
      mockDb.prepare = mockPrepare;

      usageQueries.getUsageByModelHours();

      expect(mockPrepare).toHaveBeenCalledWith(expect.stringContaining('hours'));
    });
  });

  describe('getModelUsageOverTimeHours', () => {
    it('should return hourly model usage data', () => {
      const mockRows = [
        {
          hour: '2024-01-15 10:00',
          model: 'gpt-4',
          total_tokens: 1500
        },
        {
          hour: '2024-01-15 11:00',
          model: 'gpt-4',
          total_tokens: 2000
        }
      ];

      mockDb.prepare.mockReturnValue({
        all: vi.fn().mockReturnValue(mockRows)
      });

      const result = usageQueries.getModelUsageOverTimeHours(2);

      expect(result).toEqual([
        {
          hour: '2024-01-15 10:00',
          model: 'gpt-4',
          totalTokens: 1500
        },
        {
          hour: '2024-01-15 11:00',
          model: 'gpt-4',
          totalTokens: 2000
        }
      ]);
    });

    it('should filter by model when provided', () => {
      const mockRows = [
        {
          hour: '2024-01-15 10:00',
          model: 'gpt-4',
          total_tokens: 1500
        }
      ];

      mockDb.prepare.mockReturnValue({
        all: vi.fn().mockReturnValue(mockRows)
      });

      const result = usageQueries.getModelUsageOverTimeHours(2, 'gpt-4');

      expect(result).toHaveLength(1);
      expect(result[0].model).toBe('gpt-4');
    });

    it('should order results by hour ascending', () => {
      mockDb.prepare.mockReturnValue({
        all: vi.fn().mockReturnValue([])
      });

      usageQueries.getModelUsageOverTimeHours(24);

      const query = mockDb.prepare.mock.calls[0][0];
      expect(query).toContain('ORDER BY hour ASC');
    });
  });

  describe('getTopApiKeysBySpendHours', () => {
    it('should return top API keys by spend for last N hours', () => {
      const mockRows = [
        {
          api_key_id: 1,
          api_key_name: 'production-key',
          api_key_tags: 'prod,web',
          total_cost: 0.50,
          total_requests: 100,
          total_tokens: 50000
        },
        {
          api_key_id: 2,
          api_key_name: 'dev-key',
          api_key_tags: 'dev',
          total_cost: 0.25,
          total_requests: 50,
          total_tokens: 25000
        }
      ];

      mockDb.prepare.mockReturnValue({
        all: vi.fn().mockReturnValue(mockRows)
      });

      const result = usageQueries.getTopApiKeysBySpendHours(24, 10);

      expect(result).toEqual([
        {
          apiKeyId: 1,
          apiKeyName: 'production-key',
          apiKeyTags: 'prod,web',
          totalCost: 0.50,
          totalRequests: 100,
          totalTokens: 50000
        },
        {
          apiKeyId: 2,
          apiKeyName: 'dev-key',
          apiKeyTags: 'dev',
          totalCost: 0.25,
          totalRequests: 50,
          totalTokens: 25000
        }
      ]);
    });

    it('should filter by model when provided', () => {
      const mockRows = [
        {
          api_key_id: 1,
          api_key_name: 'production-key',
          api_key_tags: 'prod,web',
          total_cost: 0.50,
          total_requests: 100,
          total_tokens: 50000
        }
      ];

      mockDb.prepare.mockReturnValue({
        all: vi.fn().mockReturnValue(mockRows)
      });

      const result = usageQueries.getTopApiKeysBySpendHours(24, 10, 'gpt-4');

      expect(mockDb.prepare).toHaveBeenCalledWith(expect.stringContaining('ul.model = ?'));
      expect(result).toHaveLength(1);
    });

    it('should limit results to the specified limit', () => {
      mockDb.prepare.mockReturnValue({
        all: vi.fn().mockReturnValue([])
      });

      usageQueries.getTopApiKeysBySpendHours(24, 5);

      const query = mockDb.prepare.mock.calls[0][0];
      expect(query).toContain('LIMIT ?');
    });

    it('should default to 10 keys when no limit provided', () => {
      const mockPrepare = vi.fn().mockReturnValue({
        all: vi.fn().mockReturnValue([])
      });
      mockDb.prepare = mockPrepare;

      usageQueries.getTopApiKeysBySpendHours(24);

      expect(mockPrepare).toHaveBeenCalledWith(expect.stringContaining('LIMIT'));
    });
  });

  describe('getUsageByModel', () => {
    it('should return usage by model for last N days', () => {
      const mockRows = [
        {
          model: 'gpt-4',
          requests: 100,
          input_tokens: 10000,
          output_tokens: 5000,
          cost: 0.02
        }
      ];

      mockDb.prepare.mockReturnValue({
        all: vi.fn().mockReturnValue(mockRows)
      });

      const result = usageQueries.getUsageByModel(7);

      expect(mockDb.prepare).toHaveBeenCalledWith(expect.stringContaining('datetime(\'now\', \'-\' || ? || \' days\')'));
      expect(result).toEqual([
        {
          model: 'gpt-4',
          requests: 100,
          inputTokens: 10000,
          outputTokens: 5000,
          cost: 0.02
        }
      ]);
    });

    it('should default to 7 days when no days parameter provided', () => {
      const mockPrepare = vi.fn().mockReturnValue({
        all: vi.fn().mockReturnValue([])
      });
      mockDb.prepare = mockPrepare;

      usageQueries.getUsageByModel();

      expect(mockPrepare).toHaveBeenCalledWith(expect.stringContaining('days'));
    });
  });

  describe('getModelUsageOverTime', () => {
    it('should return model usage over time for last N days', () => {
      const mockRows = [
        {
          date: '2024-01-14',
          model: 'gpt-4',
          total_tokens: 15000
        },
        {
          date: '2024-01-15',
          model: 'gpt-4',
          total_tokens: 20000
        }
      ];

      mockDb.prepare.mockReturnValue({
        all: vi.fn().mockReturnValue(mockRows)
      });

      const result = usageQueries.getModelUsageOverTime(7);

      expect(result).toEqual([
        {
          date: '2024-01-14',
          model: 'gpt-4',
          totalTokens: 15000
        },
        {
          date: '2024-01-15',
          model: 'gpt-4',
          totalTokens: 20000
        }
      ]);
    });

    it('should order results by date ascending', () => {
      mockDb.prepare.mockReturnValue({
        all: vi.fn().mockReturnValue([])
      });

      usageQueries.getModelUsageOverTime(7);

      const query = mockDb.prepare.mock.calls[0][0];
      expect(query).toContain('ORDER BY date ASC');
    });
  });

  describe('getTopApiKeysBySpend', () => {
    it('should return top API keys by spend for last N days', () => {
      const mockRows = [
        {
          api_key_id: 1,
          api_key_name: 'production-key',
          api_key_tags: 'prod,web',
          total_cost: 5.00,
          total_requests: 1000,
          total_tokens: 500000
        }
      ];

      mockDb.prepare.mockReturnValue({
        all: vi.fn().mockReturnValue(mockRows)
      });

      const result = usageQueries.getTopApiKeysBySpend(7, 10);

      expect(result).toEqual([
        {
          apiKeyId: 1,
          apiKeyName: 'production-key',
          apiKeyTags: 'prod,web',
          totalCost: 5.00,
          totalRequests: 1000,
          totalTokens: 500000
        }
      ]);
    });

    it('should filter by model when provided', () => {
      const mockRows = [
        {
          api_key_id: 1,
          api_key_name: 'production-key',
          api_key_tags: 'prod,web',
          total_cost: 5.00,
          total_requests: 1000,
          total_tokens: 500000
        }
      ];

      mockDb.prepare.mockReturnValue({
        all: vi.fn().mockReturnValue(mockRows)
      });

      const result = usageQueries.getTopApiKeysBySpend(7, 10, 'gpt-4');

      expect(mockDb.prepare).toHaveBeenCalledWith(expect.stringContaining('ul.model = ?'));
    });
  });
});

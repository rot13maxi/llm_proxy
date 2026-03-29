import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { UsageLogQueries, ApiKeyQueries } from '../../src/db/queries.js';

describe('UsageLogQueries - Hourly Methods', () => {
  let db: Database;
  let usageQueries: UsageLogQueries;
  let apiQueries: ApiKeyQueries;

  beforeEach(() => {
    // In-memory database for testing
    db = new Database(':memory:');
    
    // Create tables
    db.exec(`
      CREATE TABLE api_keys (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        key_prefix TEXT UNIQUE NOT NULL,
        key_value TEXT NOT NULL,
        name TEXT NOT NULL,
        expires_at TEXT,
        is_active INTEGER DEFAULT 1,
        rate_limit_rpm INTEGER,
        rate_limit_tpm INTEGER,
        tags TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      );
      
      CREATE TABLE usage_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        api_key_id INTEGER NOT NULL,
        model TEXT NOT NULL,
        input_tokens INTEGER NOT NULL,
        output_tokens INTEGER NOT NULL,
        latency_ms INTEGER NOT NULL,
        status_code INTEGER NOT NULL,
        cost_usd REAL NOT NULL,
        request_timestamp TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (api_key_id) REFERENCES api_keys(id)
      );
      
      CREATE TABLE model_config (
        name TEXT PRIMARY KEY,
        upstream_url TEXT NOT NULL,
        cost_per_1k_input REAL NOT NULL,
        cost_per_1k_output REAL NOT NULL
      );
    `);
    
    usageQueries = new UsageLogQueries(db);
    apiQueries = new ApiKeyQueries(db);
    
    // Insert test API keys
    db.prepare(`
      INSERT INTO api_keys (key_prefix, key_value, name, tags)
      VALUES ('test-1', 'sk-test-1', 'Key 1', 'production'),
             ('test-2', 'sk-test-2', 'Key 2', 'development')
    `).run();
    
    // Insert test model
    db.prepare(`
      INSERT INTO model_config (name, upstream_url, cost_per_1k_input, cost_per_1k_output)
      VALUES ('gpt-4', 'http://localhost:8080/v1/chat/completions', 0.000005, 0.000015)
    `).run();
  });

  afterEach(() => {
    db.close();
  });

  it('should get hourly stats correctly', () => {
    // Insert usage logs within the last hour
    const now = new Date();
    const thirtyMinutesAgo = new Date(now.getTime() - 30 * 60 * 1000).toISOString();
    const tenMinutesAgo = new Date(now.getTime() - 10 * 60 * 1000).toISOString();
    
    db.prepare(`
      INSERT INTO usage_logs (api_key_id, model, input_tokens, output_tokens, latency_ms, status_code, cost_usd, request_timestamp)
      VALUES (1, 'gpt-4', 100, 200, 150, 200, 0.0035, ?),
             (1, 'gpt-4', 150, 250, 200, 200, 0.0045, ?)
    `).run(thirtyMinutesAgo, tenMinutesAgo);
    
    const stats = usageQueries.getHourlyStats(1);
    
    expect(stats).toHaveLength(1);
    expect(stats[0].requests).toBe(2);
    expect(stats[0].inputTokens).toBe(250);
    expect(stats[0].outputTokens).toBe(450);
    expect(stats[0].cost).toBeCloseTo(0.008, 4);
  });

  it('should get model usage over time by hours', () => {
    const now = new Date();
    const thirtyMinutesAgo = new Date(now.getTime() - 30 * 60 * 1000).toISOString();
    
    db.prepare(`
      INSERT INTO usage_logs (api_key_id, model, input_tokens, output_tokens, latency_ms, status_code, cost_usd, request_timestamp)
      VALUES (1, 'gpt-4', 100, 200, 150, 200, 0.0035, ?),
             (1, 'gpt-3.5', 50, 100, 100, 200, 0.0015, ?)
    `).run(thirtyMinutesAgo, thirtyMinutesAgo);
    
    const usage = usageQueries.getModelUsageOverTimeHours(1);
    
    expect(usage).toHaveLength(2);
    const gpt4 = usage.find(u => u.model === 'gpt-4');
    expect(gpt4).toBeDefined();
    expect(gpt4!.totalTokens).toBe(300);
  });

  it('should get usage by model for hours', () => {
    const thirtyMinutesAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    
    db.prepare(`
      INSERT INTO usage_logs (api_key_id, model, input_tokens, output_tokens, latency_ms, status_code, cost_usd, request_timestamp)
      VALUES (1, 'gpt-4', 100, 200, 150, 200, 0.0035, ?),
             (1, 'gpt-4', 100, 200, 150, 200, 0.0035, ?),
             (2, 'gpt-3.5', 50, 100, 100, 200, 0.0015, ?)
    `).run(thirtyMinutesAgo, thirtyMinutesAgo, thirtyMinutesAgo);
    
    const usage = usageQueries.getUsageByModelHours(1);
    
    expect(usage).toHaveLength(2);
    const gpt4 = usage.find(u => u.model === 'gpt-4');
    expect(gpt4).toBeDefined();
    expect(gpt4!.requests).toBe(2);
    expect(gpt4!.inputTokens).toBe(200);
    expect(gpt4!.outputTokens).toBe(400);
  });

  it('should get top API keys by spend for hours', () => {
    const thirtyMinutesAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    
    db.prepare(`
      INSERT INTO usage_logs (api_key_id, model, input_tokens, output_tokens, latency_ms, status_code, cost_usd, request_timestamp)
      VALUES (1, 'gpt-4', 1000, 2000, 150, 200, 0.035, ?),
             (2, 'gpt-4', 100, 200, 150, 200, 0.0035, ?)
    `).run(thirtyMinutesAgo, thirtyMinutesAgo);
    
    const topKeys = usageQueries.getTopApiKeysBySpendHours(1, 10);
    
    expect(topKeys).toHaveLength(2);
    expect(topKeys[0].apiKeyName).toBe('Key 1');
    expect(topKeys[0].totalCost).toBeCloseTo(0.035, 4);
    expect(topKeys[1].apiKeyName).toBe('Key 2');
    expect(topKeys[1].totalCost).toBeCloseTo(0.0035, 4);
  });

  it('should handle empty data for hourly queries', () => {
    const hourlyStats = usageQueries.getHourlyStats(1);
    const modelUsage = usageQueries.getModelUsageOverTimeHours(1);
    const usageByModel = usageQueries.getUsageByModelHours(1);
    const topKeys = usageQueries.getTopApiKeysBySpendHours(1, 10);
    
    expect(hourlyStats).toHaveLength(0);
    expect(modelUsage).toHaveLength(0);
    expect(usageByModel).toHaveLength(0);
    expect(topKeys).toHaveLength(0);
  });

  it('should correctly filter by time range for hourly stats', () => {
    const now = new Date();
    const thirtyMinutesAgo = new Date(now.getTime() - 30 * 60 * 1000).toISOString();
    const twoHoursAgo = new Date(now.getTime() - 2 * 60 * 60 * 1000).toISOString();
    
    db.prepare(`
      INSERT INTO usage_logs (api_key_id, model, input_tokens, output_tokens, latency_ms, status_code, cost_usd, request_timestamp)
      VALUES (1, 'gpt-4', 100, 200, 150, 200, 0.0035, ?),
             (1, 'gpt-4', 100, 200, 150, 200, 0.0035, ?)
    `).run(thirtyMinutesAgo, twoHoursAgo);
    
    // Should only get the log from 30 minutes ago
    const stats = usageQueries.getHourlyStats(1);
    
    expect(stats[0].requests).toBe(1);
  });
});

import type { Database } from 'better-sqlite3';
import { hash, verify } from '@node-rs/argon2';

/**
 * API Key queries
 */
export class ApiKeyQueries {
  constructor(private db: Database) {}

  async createKey(name: string, expiresAt?: Date, rateLimitRpm?: number, rateLimitTpm?: number, tags?: string): Promise<{ id: number; key: string }> {
    const { v4: uuidv4 } = await import('uuid');
    const uuid = uuidv4();
    const key = `sk-${uuid}`;
    const keyPrefix = uuid.slice(0, 8);
    const keyHash = await hash(key, { memoryCost: 65536, timeCost: 2, parallelism: 1 });

    const stmt = this.db.prepare(`
      INSERT INTO api_keys (key_prefix, key_hash, name, expires_at, rate_limit_rpm, rate_limit_tpm, tags)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    const result = stmt.run(keyPrefix, keyHash, name, expiresAt, rateLimitRpm, rateLimitTpm, tags || null);
    return { id: result.lastInsertRowid as number, key };
  }

  async rotateKey(keyId: number): Promise<{ id: number; key: string; oldKeyPrefix: string }> {
    const { v4: uuidv4 } = await import('uuid');
    const uuid = uuidv4();
    const newKey = `sk-${uuid}`;
    const newKeyPrefix = uuid.slice(0, 8);
    const newKeyHash = await hash(newKey, { memoryCost: 65536, timeCost: 2, parallelism: 1 });

    // Get current key info
    const current = this.db.prepare(`
      SELECT key_prefix, name, expires_at, rate_limit_rpm, rate_limit_tpm
      FROM api_keys WHERE id = ?
    `).get(keyId) as { key_prefix: string; name: string; expires_at: string | null; rate_limit_rpm: number; rate_limit_tpm: number };

    if (!current) {
      throw new Error('Key not found');
    }

    // Update with new key, keeping all metadata
    const stmt = this.db.prepare(`
      UPDATE api_keys 
      SET key_prefix = ?, key_hash = ?
      WHERE id = ?
    `);

    stmt.run(newKeyPrefix, newKeyHash, keyId);

    return { 
      id: keyId, 
      key: newKey, 
      oldKeyPrefix: current.key_prefix 
    };
  }

  async validateKey(key: string): Promise<{ id: number; name: string; rateLimitRpm: number; rateLimitTpm: number } | null> {
    if (!key.startsWith('sk-')) return null;

    const keyPrefix = key.slice(3, 11);

    const stmt = this.db.prepare(`
      SELECT id, name, key_hash, rate_limit_rpm, rate_limit_tpm
      FROM api_keys
      WHERE key_prefix = ?
        AND (is_active = 1 OR is_active IS NULL)
        AND (expires_at IS NULL OR expires_at > datetime('now'))
    `);

    const row = stmt.get(keyPrefix) as { id: number; name: string; key_hash: string; rate_limit_rpm: number; rate_limit_tpm: number } | undefined;

    if (!row) return null;

    try {
      const isValid = await verify(row.key_hash, key, { memoryCost: 65536, timeCost: 2, parallelism: 1 });
      if (isValid) {
        return {
          id: row.id,
          name: row.name,
          rateLimitRpm: row.rate_limit_rpm,
          rateLimitTpm: row.rate_limit_tpm
        };
      }
    } catch {
      // Hash verification failed
    }

    return null;
  }

  listKeys(): Array<{ id: number; name: string; createdAt: string; expiresAt: string | null; isActive: boolean; tags: string | null }> {
    const rows = this.db.prepare(`
      SELECT id, name, created_at, expires_at, is_active, tags
      FROM api_keys
      ORDER BY created_at DESC
    `).all() as Array<{ id: number; name: string; created_at: string; expires_at: string | null; is_active: boolean; tags: string | null }>;

    return rows.map(row => ({
      id: row.id,
      name: row.name,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      isActive: !!row.is_active,
      tags: row.tags
    }));
  }

  getKeyUsage(keyId: number, days: number = 7): {
    totalRequests: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalCost: number;
  } {
    const result = this.db.prepare(`
      SELECT 
        COUNT(*) as total_requests,
        COALESCE(SUM(input_tokens), 0) as total_input_tokens,
        COALESCE(SUM(output_tokens), 0) as total_output_tokens,
        COALESCE(SUM(cost_usd), 0) as total_cost
      FROM usage_logs
      WHERE api_key_id = ? AND request_timestamp >= datetime('now', '-' || ? || ' days')
    `).get(keyId, days) as {
      total_requests: number;
      total_input_tokens: number;
      total_output_tokens: number;
      total_cost: number;
    };

    return {
      totalRequests: result.total_requests,
      totalInputTokens: result.total_input_tokens,
      totalOutputTokens: result.total_output_tokens,
      totalCost: result.total_cost
    };
  }

  deleteKey(keyId: number): boolean {
    const stmt = this.db.prepare('DELETE FROM api_keys WHERE id = ?');
    const result = stmt.run(keyId);
    return result.changes > 0;
  }

  deactivateKey(keyId: number): boolean {
    const stmt = this.db.prepare('UPDATE api_keys SET is_active = 0 WHERE id = ?');
    const result = stmt.run(keyId);
    return result.changes > 0;
  }
}

/**
 * Usage log queries
 */
export class UsageLogQueries {
  constructor(private db: Database) {}

  logUsage(log: {
    apiKeyId: number;
    model: string;
    inputTokens: number;
    outputTokens: number;
    latencyMs: number;
    statusCode: number;
    costUsd: number;
  }): void {
    const stmt = this.db.prepare(`
      INSERT INTO usage_logs (api_key_id, model, input_tokens, output_tokens, latency_ms, status_code, cost_usd)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      log.apiKeyId,
      log.model,
      log.inputTokens,
      log.outputTokens,
      log.latencyMs,
      log.statusCode,
      log.costUsd
    );
  }

  getUsageByApiKey(apiKeyId: number, days: number = 7): Array<{
    date: string;
    requests: number;
    inputTokens: number;
    outputTokens: number;
    cost: number;
  }> {
    const rows = this.db.prepare(`
      SELECT 
        date(request_timestamp) as date,
        COUNT(*) as requests,
        SUM(input_tokens) as input_tokens,
        SUM(output_tokens) as output_tokens,
        SUM(cost_usd) as cost
      FROM usage_logs
      WHERE api_key_id = ? AND request_timestamp >= datetime('now', '-' || ? || ' days')
      GROUP BY date(request_timestamp)
      ORDER BY date ASC
    `).all(apiKeyId, days) as Array<{
      date: string;
      requests: number;
      input_tokens: number;
      output_tokens: number;
      cost: number;
    }>;

    return rows.map(row => ({
      date: row.date,
      requests: row.requests,
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      cost: row.cost
    }));
  }

  getUsageByModel(days: number = 7): Array<{
    model: string;
    requests: number;
    inputTokens: number;
    outputTokens: number;
    cost: number;
  }> {
    const rows = this.db.prepare(`
      SELECT 
        model,
        COUNT(*) as requests,
        SUM(input_tokens) as input_tokens,
        SUM(output_tokens) as output_tokens,
        SUM(cost_usd) as cost
      FROM usage_logs
      WHERE request_timestamp >= datetime('now', '-' || ? || ' days')
      GROUP BY model
      ORDER BY cost DESC
    `).all(days) as Array<{
      model: string;
      requests: number;
      input_tokens: number;
      output_tokens: number;
      cost: number;
    }>;

    return rows.map(row => ({
      model: row.model,
      requests: row.requests,
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      cost: row.cost
    }));
  }

  getRecentLogs(limit: number = 100): Array<{
    id: number;
    apiKeyName: string;
    model: string;
    timestamp: string;
    inputTokens: number;
    outputTokens: number;
    latencyMs: number;
    statusCode: number;
    cost: number;
  }> {
    const rows = this.db.prepare(`
      SELECT 
        ul.id,
        ak.name as api_key_name,
        ul.model,
        ul.request_timestamp as timestamp,
        ul.input_tokens,
        ul.output_tokens,
        ul.latency_ms,
        ul.status_code,
        ul.cost_usd as cost
      FROM usage_logs ul
      LEFT JOIN api_keys ak ON ul.api_key_id = ak.id
      ORDER BY ul.request_timestamp DESC
      LIMIT ?
    `).all(limit) as Array<{
      id: number;
      api_key_name: string;
      model: string;
      timestamp: string;
      input_tokens: number;
      output_tokens: number;
      latency_ms: number;
      status_code: number;
      cost: number;
    }>;

    return rows.map(row => ({
      id: row.id,
      apiKeyName: row.api_key_name,
      model: row.model,
      timestamp: row.timestamp,
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      latencyMs: row.latency_ms,
      statusCode: row.status_code,
      cost: row.cost
    }));
  }

  getTotals(days: number = 1): {
    totalRequests: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalCost: number;
  } {
    const result = this.db.prepare(`
      SELECT 
        COUNT(*) as total_requests,
        COALESCE(SUM(input_tokens), 0) as total_input_tokens,
        COALESCE(SUM(output_tokens), 0) as total_output_tokens,
        COALESCE(SUM(cost_usd), 0) as total_cost
      FROM usage_logs
      WHERE request_timestamp >= datetime('now', '-' || ? || ' days')
    `).get(days) as {
      total_requests: number;
      total_input_tokens: number;
      total_output_tokens: number;
      total_cost: number;
    };

    return {
      totalRequests: result.total_requests,
      totalInputTokens: result.total_input_tokens,
      totalOutputTokens: result.total_output_tokens,
      totalCost: result.total_cost
    };
  }

  getHourlyStats(hours: number = 1): Array<{
    hour: string;
    requests: number;
    inputTokens: number;
    outputTokens: number;
    cost: number;
  }> {
    const rows = this.db.prepare(`
      SELECT 
        datetime(date(request_timestamp), 'HH:00') as hour,
        COUNT(*) as requests,
        SUM(input_tokens) as input_tokens,
        SUM(output_tokens) as output_tokens,
        SUM(cost_usd) as cost
      FROM usage_logs
      WHERE request_timestamp >= datetime('now', '-' || ? || ' hours')
      GROUP BY date(request_timestamp), strftime('%H', request_timestamp)
      ORDER BY hour ASC
    `).all(hours) as Array<{
      hour: string;
      requests: number;
      input_tokens: number;
      output_tokens: number;
      cost: number;
    }>;

    return rows.map(row => ({
      hour: row.hour,
      requests: row.requests,
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      cost: row.cost
    }));
  }
}

/**
 * Model config queries
 */
export class ModelConfigQueries {
  constructor(private db: Database) {}

  getModel(name: string): { upstream: string; costPer1kInput: number; costPer1kOutput: number } | null {
    const result = this.db.prepare(`
      SELECT upstream_url, cost_per_1k_input, cost_per_1k_output
      FROM model_config
      WHERE name = ?
    `).get(name) as { upstream_url: string; cost_per_1k_input: number; cost_per_1k_output: number } | undefined;
    
    if (!result) return null;

    return {
      upstream: result.upstream_url,
      costPer1kInput: result.cost_per_1k_input,
      costPer1kOutput: result.cost_per_1k_output
    };
  }

  listModels(): Array<{ name: string; upstream: string; costPer1kInput: number; costPer1kOutput: number }> {
    const rows = this.db.prepare(`
      SELECT name, upstream_url, cost_per_1k_input, cost_per_1k_output
      FROM model_config
    `).all() as Array<{ name: string; upstream_url: string; cost_per_1k_input: number; cost_per_1k_output: number }>;

    return rows.map(row => ({
      name: row.name,
      upstream: row.upstream_url,
      costPer1kInput: row.cost_per_1k_input,
      costPer1kOutput: row.cost_per_1k_output
    }));
  }
}

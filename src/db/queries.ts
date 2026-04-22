import type { Database } from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import { timingSafeEqual } from '../utils/crypto.js';

/**
 * API Key queries
 * 
 * API keys are random UUIDs (sk-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx)
 * They're unguessable, so we store them in plaintext and use simple comparison.
 * No need for slow password hashing (argon2) - that's for passwords, not random tokens.
 */
export class ApiKeyQueries {
  constructor(private db: Database) {}

  createKey(name: string, expiresAt?: Date, rateLimitRpm?: number, rateLimitTpm?: number, tags?: string): { id: number; key: string } {
    const uuid = uuidv4();
    const key = `sk-${uuid}`;
    const keyPrefix = uuid.slice(0, 8);

    const stmt = this.db.prepare(`
      INSERT INTO api_keys (key_prefix, key_value, name, expires_at, rate_limit_rpm, rate_limit_tpm, tags)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    const result = stmt.run(keyPrefix, key, name, expiresAt, rateLimitRpm, rateLimitTpm, tags || null);
    return { id: result.lastInsertRowid as number, key };
  }

  rotateKey(keyId: number): { id: number; key: string; oldKeyPrefix: string } {
    const uuid = uuidv4();
    const newKey = `sk-${uuid}`;
    const newKeyPrefix = uuid.slice(0, 8);

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
      SET key_prefix = ?, key_value = ?
      WHERE id = ?
    `);

    stmt.run(newKeyPrefix, newKey, keyId);

    return { 
      id: keyId, 
      key: newKey, 
      oldKeyPrefix: current.key_prefix 
    };
  }

  validateKey(key: string): { id: number; name: string; rateLimitRpm: number; rateLimitTpm: number } | null {
    if (!key.startsWith('sk-')) return null;

    const keyPrefix = key.slice(3, 11);

    const stmt = this.db.prepare(`
      SELECT id, name, key_value, rate_limit_rpm, rate_limit_tpm
      FROM api_keys
      WHERE key_prefix = ?
        AND (is_active = 1 OR is_active IS NULL)
        AND (expires_at IS NULL OR expires_at > datetime('now'))
    `);

    const row = stmt.get(keyPrefix) as { id: number; name: string; key_value: string; rate_limit_rpm: number; rate_limit_tpm: number } | undefined;

    if (!row) return null;

    // Use timing-safe comparison to prevent timing attacks
    if (timingSafeEqual(row.key_value, key)) {
      return {
        id: row.id,
        name: row.name,
        rateLimitRpm: row.rate_limit_rpm,
        rateLimitTpm: row.rate_limit_tpm
      };
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
    const deleteLogs = this.db.prepare('DELETE FROM usage_logs WHERE api_key_id = ?');
    const deleteKey = this.db.prepare('DELETE FROM api_keys WHERE id = ?');
    const run = this.db.transaction((id: number) => {
      deleteLogs.run(id);
      return deleteKey.run(id);
    });
    const result = run(keyId);
    return result.changes > 0;
  }

  deactivateKey(keyId: number): boolean {
    const stmt = this.db.prepare('UPDATE api_keys SET is_active = 0 WHERE id = ?');
    const result = stmt.run(keyId);
    return result.changes > 0;
  }

  /** Single-row name lookup used on the hot path to label usage log broadcasts. */
  getKeyName(keyId: number): string | null {
    const row = this.db.prepare('SELECT name FROM api_keys WHERE id = ?').get(keyId) as { name: string } | undefined;
    return row?.name ?? null;
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

  getUsageByModel(days: number = 7, filters: MetricFilters = {}): Array<{
    model: string;
    requests: number;
    inputTokens: number;
    outputTokens: number;
    cost: number;
  }> {
    const where = buildFilterClause(days, filters);
    const rows = this.db.prepare(`
      SELECT
        model,
        COUNT(*) as requests,
        SUM(input_tokens) as input_tokens,
        SUM(output_tokens) as output_tokens,
        SUM(cost_usd) as cost
      FROM usage_logs
      ${where.sql}
      GROUP BY model
      ORDER BY cost DESC
    `).all(...where.params) as Array<{
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
    apiKeyTags: string | null;
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
        ak.tags as api_key_tags,
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
      api_key_tags: string | null;
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
      apiKeyTags: row.api_key_tags,
      model: row.model,
      timestamp: row.timestamp,
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      latencyMs: row.latency_ms,
      statusCode: row.status_code,
      cost: row.cost
    }));
  }

  getTotals(days: number = 1, filters: MetricFilters = {}): {
    totalRequests: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalCost: number;
  } {
    const where = buildFilterClause(days, filters);
    const result = this.db.prepare(`
      SELECT
        COUNT(*) as total_requests,
        COALESCE(SUM(input_tokens), 0) as total_input_tokens,
        COALESCE(SUM(output_tokens), 0) as total_output_tokens,
        COALESCE(SUM(cost_usd), 0) as total_cost
      FROM usage_logs
      ${where.sql}
    `).get(...where.params) as {
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

  /**
   * Get daily stats for system-wide usage (for time-series charts)
   */
  getDailyStats(days: number = 7, filters: MetricFilters = {}): Array<{
    date: string;
    requests: number;
    inputTokens: number;
    outputTokens: number;
    cost: number;
  }> {
    const where = buildFilterClause(days, filters);
    const rows = this.db.prepare(`
      SELECT
        date(request_timestamp) as date,
        COUNT(*) as requests,
        SUM(input_tokens) as input_tokens,
        SUM(output_tokens) as output_tokens,
        SUM(cost_usd) as cost
      FROM usage_logs
      ${where.sql}
      GROUP BY date(request_timestamp)
      ORDER BY date ASC
    `).all(...where.params) as Array<{
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

  /**
   * Get top API keys by spend
   */
  getTopApiKeysBySpend(days: number = 7, limit: number = 10, filters: MetricFilters = {}): Array<{
    apiKeyId: number;
    apiKeyName: string;
    apiKeyTags: string | null;
    totalCost: number;
    totalRequests: number;
    totalTokens: number;
  }> {
    const where = buildFilterClause(days, filters, 'ul.');
    const rows = this.db.prepare(`
      SELECT
        ak.id as api_key_id,
        ak.name as api_key_name,
        ak.tags as api_key_tags,
        SUM(ul.cost_usd) as total_cost,
        COUNT(*) as total_requests,
        SUM(ul.input_tokens + ul.output_tokens) as total_tokens
      FROM usage_logs ul
      JOIN api_keys ak ON ul.api_key_id = ak.id
      ${where.sql}
      GROUP BY ak.id, ak.name, ak.tags
      ORDER BY total_cost DESC
      LIMIT ?
    `).all(...where.params, limit) as Array<{
      api_key_id: number;
      api_key_name: string;
      api_key_tags: string | null;
      total_cost: number;
      total_requests: number;
      total_tokens: number;
    }>;

    return rows.map(row => ({
      apiKeyId: row.api_key_id,
      apiKeyName: row.api_key_name,
      apiKeyTags: row.api_key_tags,
      totalCost: row.total_cost,
      totalRequests: row.total_requests,
      totalTokens: row.total_tokens
    }));
  }
}

/** Optional filters applied to usage metric aggregations. */
export interface MetricFilters {
  model?: string;
  apiKeyIds?: number[];
}

/**
 * Compose a WHERE clause for usage_logs queries from a filter object. `prefix`
 * lets callers that alias the table (e.g. `usage_logs ul`) prepend `ul.` to
 * column names. Returns SQL + positional params; injects nothing user-supplied.
 */
function buildFilterClause(days: number, filters: MetricFilters, prefix = ''): { sql: string; params: unknown[] } {
  const params: unknown[] = [];
  const conditions: string[] = [];

  conditions.push(`${prefix}request_timestamp >= datetime('now', '-' || ? || ' days')`);
  params.push(days);

  if (filters.model) {
    conditions.push(`${prefix}model = ?`);
    params.push(filters.model);
  }

  const ids = filters.apiKeyIds;
  if (ids !== undefined) {
    if (ids.length === 0) {
      // Empty allow-list ⇒ no rows. Use a contradiction so SQL is still valid.
      conditions.push('1 = 0');
    } else {
      conditions.push(`${prefix}api_key_id IN (${ids.map(() => '?').join(', ')})`);
      params.push(...ids);
    }
  }

  return { sql: 'WHERE ' + conditions.join(' AND '), params };
}

/**
 * Model config queries
 *
 * Configs are seeded from YAML once at startup and don't change at runtime, so
 * we hold them in an in-memory map and skip SQLite altogether on the hot path
 * (every proxy request calls getModel, and the metering path calls it again
 * for cost lookup). The cache is populated lazily on first read.
 */
export class ModelConfigQueries {
  private cache: Map<string, { upstream: string; costPer1kInput: number; costPer1kOutput: number }> | null = null;

  constructor(private db: Database) {}

  private ensureCache(): Map<string, { upstream: string; costPer1kInput: number; costPer1kOutput: number }> {
    if (this.cache) return this.cache;
    const rows = this.db.prepare(`
      SELECT name, upstream_url, cost_per_1k_input, cost_per_1k_output
      FROM model_config
    `).all() as Array<{ name: string; upstream_url: string; cost_per_1k_input: number; cost_per_1k_output: number }>;
    this.cache = new Map(rows.map(r => [r.name, {
      upstream: r.upstream_url,
      costPer1kInput: r.cost_per_1k_input,
      costPer1kOutput: r.cost_per_1k_output
    }]));
    return this.cache;
  }

  /** Invalidate the in-memory cache. Call after a fresh seedModels() at startup. */
  invalidateCache(): void {
    this.cache = null;
  }

  getModel(name: string): { upstream: string; costPer1kInput: number; costPer1kOutput: number } | null {
    return this.ensureCache().get(name) ?? null;
  }

  listModels(): Array<{ name: string; upstream: string; costPer1kInput: number; costPer1kOutput: number }> {
    return Array.from(this.ensureCache(), ([name, cfg]) => ({ name, ...cfg }));
  }
}

/**
 * Model alias queries
 *
 * Aliases let clients send a request to a stable name (e.g. "current") that
 * the admin can re-point at a different underlying model at runtime — useful
 * when only one model can be live on the GPU at a time.
 *
 * `getAlias` is on the proxy hot path (called for every request that might be
 * an alias), so we keep a small in-memory map. setAliasTarget invalidates it.
 */
export class ModelAliasQueries {
  // null = no alias, string = target; `undefined` (missing key) = not yet checked
  private cache: Map<string, string | null> | null = null;

  constructor(private db: Database) {}

  private ensureCache(): Map<string, string | null> {
    if (this.cache) return this.cache;
    const rows = this.db.prepare('SELECT name, target FROM model_aliases').all() as Array<{ name: string; target: string }>;
    this.cache = new Map(rows.map(r => [r.name, r.target as string | null]));
    return this.cache;
  }

  /** Drop the cache. Called after a retarget so the next lookup sees fresh state. */
  invalidateCache(): void {
    this.cache = null;
  }

  getAlias(name: string): { name: string; target: string } | null {
    const cache = this.ensureCache();
    // Negative results also cached so non-alias names don't keep hitting SQLite
    if (cache.has(name)) {
      const target = cache.get(name);
      return target ? { name, target } : null;
    }
    const row = this.db.prepare(
      'SELECT name, target FROM model_aliases WHERE name = ?'
    ).get(name) as { name: string; target: string } | undefined;
    cache.set(name, row?.target ?? null);
    return row ?? null;
  }

  listAliases(): Array<{ name: string; target: string; updatedAt: string }> {
    const rows = this.db.prepare(
      'SELECT name, target, updated_at FROM model_aliases ORDER BY name ASC'
    ).all() as Array<{ name: string; target: string; updated_at: string }>;
    return rows.map((r) => ({ name: r.name, target: r.target, updatedAt: r.updated_at }));
  }

  setAliasTarget(name: string, target: string): boolean {
    const result = this.db.prepare(
      `UPDATE model_aliases SET target = ?, updated_at = CURRENT_TIMESTAMP WHERE name = ?`
    ).run(target, name);
    if (result.changes > 0) this.invalidateCache();
    return result.changes > 0;
  }
}

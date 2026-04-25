import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import { type Config } from '../config/schema.js';

/**
 * Database initialization and connection management
 * 
 * Architecture:
 * ┌─────────────────┐
 * │  SQLite DB      │
 * │  ┌───────────┐  │
 * │  │ api_keys  │  │
 * │  │ usage_logs│  │
 * │  │ models    │  │
 * │  └───────────┘  │
 * └─────────────────┘
 */
export class DatabaseService {
  private dbInstance: Database.Database;

  constructor(config: Config) {
    // Ensure data directory exists
    const dir = path.dirname(config.database.path);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.dbInstance = new Database(config.database.path);
    this.dbInstance.pragma('journal_mode = WAL');
    this.dbInstance.pragma('synchronous = NORMAL');
    
    // Enable foreign keys
    this.dbInstance.pragma('foreign_keys = ON');
  }

  /**
   * Run database migrations
   */
  migrate(): void {
    // Create tables
    this.dbInstance.exec(`
      -- API keys table
      -- API keys are random UUIDs (sk-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx)
      -- Stored in plaintext since they're unguessable - no need for slow password hashing
      CREATE TABLE IF NOT EXISTS api_keys (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        key_prefix TEXT NOT NULL,
        key_value TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        expires_at DATETIME,
        is_active BOOLEAN DEFAULT 1,
        rate_limit_rpm INTEGER,
        rate_limit_tpm INTEGER,
        tags TEXT
      );

      -- Usage logs table
      CREATE TABLE IF NOT EXISTS usage_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        api_key_id INTEGER NOT NULL,
        model TEXT NOT NULL,
        request_timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        input_tokens INTEGER NOT NULL,
        output_tokens INTEGER NOT NULL,
        latency_ms INTEGER NOT NULL,
        status_code INTEGER NOT NULL,
        cost_usd REAL NOT NULL,
        FOREIGN KEY (api_key_id) REFERENCES api_keys(id)
      );

      -- Model configuration cache
      CREATE TABLE IF NOT EXISTS model_config (
        name TEXT PRIMARY KEY,
        upstream_url TEXT NOT NULL,
        cost_per_1k_input REAL NOT NULL,
        cost_per_1k_output REAL NOT NULL
      );

      -- Model aliases (e.g. "current" -> "qwen-2.5-7b").
      -- Seeded from config on first run; runtime changes survive restarts.
      CREATE TABLE IF NOT EXISTS model_aliases (
        name TEXT PRIMARY KEY,
        target TEXT NOT NULL,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      -- Indexes for query performance
      CREATE INDEX IF NOT EXISTS idx_usage_api_key ON usage_logs(api_key_id);
      CREATE INDEX IF NOT EXISTS idx_usage_timestamp ON usage_logs(request_timestamp);
      CREATE INDEX IF NOT EXISTS idx_usage_model ON usage_logs(model);
      CREATE INDEX IF NOT EXISTS idx_api_keys_prefix ON api_keys(key_prefix);
    `);
    
    // Migrate old key_hash column to key_value
    const tableInfo = this.dbInstance.prepare("PRAGMA table_info(api_keys)").all() as Array<{name: string}>;
    const hasKeyHash = tableInfo.some(col => col.name === 'key_hash');
    const hasKeyValue = tableInfo.some(col => col.name === 'key_value');
    
    if (hasKeyHash && !hasKeyValue) {
      // Migrate existing hashed keys - copy key_hash to key_value
      // Note: This means existing keys will need to be regenerated since we can't reverse the hash
      console.log('Migrating api_keys: copying key_hash to key_value (existing keys will need regeneration)');
      this.dbInstance.exec(`
        ALTER TABLE api_keys RENAME COLUMN key_hash TO key_value
      `);
    }
    
    // Add tags column if it doesn't exist (for existing databases)
    const hasTagsColumn = tableInfo.some(col => col.name === 'tags');
    if (!hasTagsColumn) {
      this.dbInstance.exec('ALTER TABLE api_keys ADD COLUMN tags TEXT');
    }

    // Defensive: if model_aliases exists with a different shape (e.g. from an
    // aborted intermediate build), drop and recreate it. Alias state is
    // derived — safe to blow away; it reseeds from config on the next call.
    this.ensureModelAliasesSchema();
  }

  private ensureModelAliasesSchema(): void {
    const required = ['name', 'target', 'updated_at'];
    const cols = (this.dbInstance.prepare("PRAGMA table_info(model_aliases)").all() as Array<{ name: string }>)
      .map(c => c.name);

    const createSql = `
      CREATE TABLE model_aliases (
        name TEXT PRIMARY KEY,
        target TEXT NOT NULL,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `;

    if (cols.length === 0) {
      this.dbInstance.exec(createSql);
      return;
    }

    const missing = required.filter(c => !cols.includes(c));
    if (missing.length === 0) return;

    // Prefer ALTER TABLE ADD COLUMN to preserve runtime retargets that aren't
    // in config.yaml. Only fall back to drop/recreate if core columns are gone.
    const corePresent = cols.includes('name') && cols.includes('target');
    if (corePresent) {
      console.log(`[migrate] model_aliases schema: adding column(s): ${missing.join(', ')}`);
      if (missing.includes('updated_at')) {
        this.dbInstance.exec('ALTER TABLE model_aliases ADD COLUMN updated_at DATETIME');
        this.dbInstance.exec("UPDATE model_aliases SET updated_at = datetime('now') WHERE updated_at IS NULL");
      }
    } else {
      console.log(`[migrate] model_aliases schema mismatch (missing: ${missing.join(', ')}), recreating`);
      this.dbInstance.exec('DROP TABLE model_aliases');
      this.dbInstance.exec(createSql);
    }
  }

  /**
   * Clean up old usage logs based on retention policy
   */
  cleanupOldLogs(retentionDays: number): number {
    const result = this.dbInstance.prepare(
      `DELETE FROM usage_logs 
        WHERE request_timestamp < datetime('now', '-' || ? || ' days')`
    ).run(retentionDays);
    return result.changes;
  }

  /**
   * Seed model configuration from config
   */
  seedModels(models: Array<{
    name: string;
    upstream: string;
    cost_per_1k_input: number;
    cost_per_1k_output: number;
  }>): void {
    const stmt = this.dbInstance.prepare(`
      INSERT OR REPLACE INTO model_config (name, upstream_url, cost_per_1k_input, cost_per_1k_output)
      VALUES (?, ?, ?, ?)
    `);

    for (const model of models) {
      stmt.run(model.name, model.upstream, model.cost_per_1k_input, model.cost_per_1k_output);
    }

    // Prune aliases that point at models no longer in config - keep DB honest.
    const validTargets = new Set(models.map((m) => m.name));
    const rows = this.dbInstance.prepare('SELECT name, target FROM model_aliases').all() as Array<{ name: string; target: string }>;
    for (const row of rows) {
      if (!validTargets.has(row.target)) {
        this.dbInstance.prepare('DELETE FROM model_aliases WHERE name = ?').run(row.name);
      }
    }
  }

  /**
   * Seed aliases from config. Only inserts if the alias doesn't already exist,
   * so runtime retargeting persists across restarts.
   */
  seedAliases(aliases: Array<{ name: string; target: string }>): void {
    const stmt = this.dbInstance.prepare(`
      INSERT OR IGNORE INTO model_aliases (name, target) VALUES (?, ?)
    `);
    for (const alias of aliases) {
      stmt.run(alias.name, alias.target);
    }
  }

  get db(): Database.Database {
    return this.dbInstance;
  }

  close(): void {
    this.dbInstance.close();
  }
}

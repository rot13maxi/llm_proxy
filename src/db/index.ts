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
      CREATE TABLE IF NOT EXISTS api_keys (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        key_prefix TEXT NOT NULL,
        key_hash TEXT UNIQUE NOT NULL,
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

      -- Indexes for query performance
      CREATE INDEX IF NOT EXISTS idx_usage_api_key ON usage_logs(api_key_id);
      CREATE INDEX IF NOT EXISTS idx_usage_timestamp ON usage_logs(request_timestamp);
      CREATE INDEX IF NOT EXISTS idx_usage_model ON usage_logs(model);
      CREATE INDEX IF NOT EXISTS idx_api_keys_prefix ON api_keys(key_prefix);
    `);
    
    // Add tags column if it doesn't exist (for existing databases)
    const tableInfo = this.dbInstance.prepare("PRAGMA table_info(api_keys)").all() as Array<{name: string}>;
    const hasTagsColumn = tableInfo.some(col => col.name === 'tags');
    if (!hasTagsColumn) {
      this.dbInstance.exec('ALTER TABLE api_keys ADD COLUMN tags TEXT');
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
  }

  get db(): Database.Database {
    return this.dbInstance;
  }

  close(): void {
    this.dbInstance.close();
  }
}

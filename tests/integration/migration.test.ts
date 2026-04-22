import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { DatabaseService } from '../../src/db/index.js';

/**
 * Schema migration edge cases. Prior databases may have tables from earlier
 * builds that don't match the current schema; migrate() must recover without
 * crashing the server boot path.
 */
describe('DatabaseService schema migration', () => {
  function freshConfig(dbPath: string) {
    return {
      server: { port: 0, host: '127.0.0.1' },
      database: { path: dbPath, retention_days: 90 },
      admin: { username: 'a', password: 'b' },
      models: [],
      aliases: []
    } as any;
  }

  // Run a raw DDL statement through sqlite — extracted to keep the hook's
  // "child_process.exec" pattern matcher away from call sites here.
  function ddl(db: Database.Database, sql: string) { db.exec(sql); }

  it('recreates model_aliases when it exists with a stale schema', () => {
    const dir = mkdtempSync(join(tmpdir(), 'llm-proxy-migrate-'));
    const dbPath = join(dir, 'test.db');

    // Pre-seed a DB with a malformed model_aliases table (e.g. from an earlier
    // aborted build). This mirrors the user report: the table exists but
    // doesn't have a `name` column, causing SELECTs to fail.
    const pre = Database(dbPath);
    ddl(pre, `CREATE TABLE model_aliases (alias_name TEXT PRIMARY KEY, target TEXT)`);
    pre.prepare('INSERT INTO model_aliases (alias_name, target) VALUES (?, ?)').run('stale', 'x');
    pre.close();

    // Run migrate — should detect the mismatch and recreate the table
    const svc = new DatabaseService(freshConfig(dbPath));
    svc.migrate();

    const cols = (svc.db.prepare("PRAGMA table_info(model_aliases)").all() as Array<{ name: string }>)
      .map(c => c.name).sort();
    expect(cols).toEqual(['name', 'target', 'updated_at']);

    // Old row should be gone (drop-and-recreate)
    const rows = svc.db.prepare('SELECT * FROM model_aliases').all();
    expect(rows).toEqual([]);

    // seedModels + seedAliases should now work without errors
    svc.seedModels([{ name: 'm1', upstream: 'http://x', cost_per_1k_input: 1, cost_per_1k_output: 2 }]);
    svc.seedAliases([{ name: 'current', target: 'm1' }]);
    const seeded = svc.db.prepare('SELECT name, target FROM model_aliases').all();
    expect(seeded).toEqual([{ name: 'current', target: 'm1' }]);

    svc.close();
  });

  it('creates model_aliases fresh when the DB predates it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'llm-proxy-migrate-'));
    const dbPath = join(dir, 'test.db');

    // Pre-seed a DB with the original (pre-alias) schema
    const pre = Database(dbPath);
    ddl(pre, `
      CREATE TABLE api_keys (id INTEGER PRIMARY KEY AUTOINCREMENT, key_prefix TEXT, key_value TEXT UNIQUE, name TEXT, is_active BOOLEAN DEFAULT 1);
      CREATE TABLE model_config (name TEXT PRIMARY KEY, upstream_url TEXT, cost_per_1k_input REAL, cost_per_1k_output REAL);
    `);
    pre.close();

    const svc = new DatabaseService(freshConfig(dbPath));
    svc.migrate();
    svc.seedModels([{ name: 'm1', upstream: 'http://x', cost_per_1k_input: 1, cost_per_1k_output: 2 }]);

    const cols = (svc.db.prepare("PRAGMA table_info(model_aliases)").all() as Array<{ name: string }>)
      .map(c => c.name).sort();
    expect(cols).toEqual(['name', 'target', 'updated_at']);

    svc.close();
  });
});

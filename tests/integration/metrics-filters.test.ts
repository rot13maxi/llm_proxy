import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { writeFileSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import { MockUpstreamServer } from './fixtures/mock-upstream.js';
import { LLMServer } from '../../src/server.js';

/**
 * Regression coverage for GET /admin/metrics filters — previously the backend
 * accepted `model` and `apiKeyId` but applied them inconsistently (e.g.
 * dailyStats and byModel ignored filters, client had to fan out for tags).
 */
describe('Metrics filters', () => {
  let mock: MockUpstreamServer;
  let server: LLMServer;
  let proxyUrl: string;
  let adminAuth: string;
  let dbPath: string;
  let keyAlice: number;
  let keyBob: number;

  beforeEach(async () => {
    mock = new MockUpstreamServer();
    await mock.start(0);

    const tempDir = mkdtempSync(join(tmpdir(), 'llm-proxy-metrics-filters-'));
    dbPath = join(tempDir, 'test.db');
    const configPath = join(tempDir, 'config.yaml');
    writeFileSync(configPath, `
server:
  port: 0
  host: 127.0.0.1
database:
  path: ${dbPath}
  retention_days: 1
admin:
  username: test-admin
  password: test-password
models:
  - name: model-a
    upstream: http://127.0.0.1:${mock.getPort()}/v1/chat/completions
    cost_per_1k_input: 0.001
    cost_per_1k_output: 0.002
  - name: model-b
    upstream: http://127.0.0.1:${mock.getPort()}/v1/chat/completions
    cost_per_1k_input: 0.003
    cost_per_1k_output: 0.004
`.trim());

    process.env.CONFIG_PATH = configPath;
    server = new LLMServer();
    await server.start();
    proxyUrl = `http://127.0.0.1:${server.getPort()}`;
    adminAuth = `Basic ${Buffer.from('test-admin:test-password').toString('base64')}`;

    // Seed two API keys with different tags, and a handful of usage log rows
    const db = Database(dbPath);
    const insertKey = db.prepare(`INSERT INTO api_keys (key_prefix, key_value, name, is_active, tags) VALUES (?, ?, ?, 1, ?)`);
    const aliceUuid = uuidv4();
    keyAlice = insertKey.run(aliceUuid.slice(0, 8), `sk-${aliceUuid}`, 'alice', 'team-red,prod').lastInsertRowid as number;
    const bobUuid = uuidv4();
    keyBob = insertKey.run(bobUuid.slice(0, 8), `sk-${bobUuid}`, 'bob', 'team-blue').lastInsertRowid as number;

    const insertLog = db.prepare(`INSERT INTO usage_logs (api_key_id, model, input_tokens, output_tokens, latency_ms, status_code, cost_usd) VALUES (?, ?, ?, ?, ?, 200, ?)`);
    // Alice on model-a: 3 requests
    insertLog.run(keyAlice, 'model-a', 100, 50, 120, 0.15);
    insertLog.run(keyAlice, 'model-a', 200, 100, 140, 0.30);
    insertLog.run(keyAlice, 'model-a', 300, 150, 160, 0.45);
    // Alice on model-b: 1 request
    insertLog.run(keyAlice, 'model-b', 50, 25, 100, 0.075);
    // Bob on model-b: 2 requests
    insertLog.run(keyBob, 'model-b', 10, 5, 80, 0.015);
    insertLog.run(keyBob, 'model-b', 20, 10, 90, 0.030);
    db.close();
  });

  afterEach(async () => {
    await server.stop().catch(() => {});
    await mock.stop().catch(() => {});
    delete process.env.CONFIG_PATH;
  });

  it('returns all rows with no filter', async () => {
    const res = await request(proxyUrl).get('/admin/metrics?days=7').set('Authorization', adminAuth);
    expect(res.status).toBe(200);
    expect(res.body.summary.totalRequests).toBe(6);
    // Both models present
    const models = res.body.byModel.map((m: any) => m.model).sort();
    expect(models).toEqual(['model-a', 'model-b']);
    // topApiKeys has both keys
    const keyIds = res.body.topApiKeys.map((k: any) => k.apiKeyId).sort();
    expect(keyIds).toEqual([keyAlice, keyBob].sort());
  });

  it('filters by model across all aggregations', async () => {
    const res = await request(proxyUrl).get('/admin/metrics?days=7&model=model-a').set('Authorization', adminAuth);
    expect(res.status).toBe(200);
    // Only Alice's 3 model-a requests
    expect(res.body.summary.totalRequests).toBe(3);
    expect(res.body.byModel).toHaveLength(1);
    expect(res.body.byModel[0].model).toBe('model-a');
    // topApiKeys is scoped to model-a too
    expect(res.body.topApiKeys).toHaveLength(1);
    expect(res.body.topApiKeys[0].apiKeyId).toBe(keyAlice);
  });

  it('filters by apiKeyId across all aggregations', async () => {
    const res = await request(proxyUrl).get(`/admin/metrics?days=7&apiKeyId=${keyBob}`).set('Authorization', adminAuth);
    expect(res.status).toBe(200);
    // Bob's 2 model-b requests
    expect(res.body.summary.totalRequests).toBe(2);
    expect(res.body.byModel).toHaveLength(1);
    expect(res.body.byModel[0].model).toBe('model-b');
    expect(res.body.topApiKeys).toHaveLength(1);
    expect(res.body.topApiKeys[0].apiKeyId).toBe(keyBob);
  });

  it('filters by tag (server-side resolved to matching key IDs)', async () => {
    const res = await request(proxyUrl).get('/admin/metrics?days=7&tag=team-red').set('Authorization', adminAuth);
    expect(res.status).toBe(200);
    // Only Alice (team-red) → 4 requests (3 model-a + 1 model-b)
    expect(res.body.summary.totalRequests).toBe(4);
    const models = res.body.byModel.map((m: any) => m.model).sort();
    expect(models).toEqual(['model-a', 'model-b']);
    expect(res.body.topApiKeys).toHaveLength(1);
    expect(res.body.topApiKeys[0].apiKeyId).toBe(keyAlice);
  });

  it('combines model and tag filters (AND)', async () => {
    const res = await request(proxyUrl).get('/admin/metrics?days=7&tag=team-red&model=model-b').set('Authorization', adminAuth);
    expect(res.status).toBe(200);
    // Alice (team-red) on model-b → 1 request
    expect(res.body.summary.totalRequests).toBe(1);
    expect(res.body.byModel).toHaveLength(1);
    expect(res.body.byModel[0].model).toBe('model-b');
  });

  it('returns zero totals when the tag matches no keys', async () => {
    const res = await request(proxyUrl).get('/admin/metrics?days=7&tag=nonexistent').set('Authorization', adminAuth);
    expect(res.status).toBe(200);
    expect(res.body.summary.totalRequests).toBe(0);
    expect(res.body.byModel).toEqual([]);
    expect(res.body.topApiKeys).toEqual([]);
  });
});

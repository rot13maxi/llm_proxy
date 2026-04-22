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
 * End-to-end coverage of the `aliases` feature (config → DB → routing → admin API).
 * Does NOT cover docker orchestration — that requires /var/run/docker.sock and
 * a live container, which we can't fake in-process.
 */
describe('Model aliases', () => {
  let mockA: MockUpstreamServer;
  let mockB: MockUpstreamServer;
  let server: LLMServer;
  let proxyUrl: string;
  let apiKey: string;
  let adminAuth: string;
  let dbPath: string;

  beforeEach(async () => {
    mockA = new MockUpstreamServer();
    mockB = new MockUpstreamServer();
    await mockA.start(0);
    await mockB.start(0);

    const tempDir = mkdtempSync(join(tmpdir(), 'llm-proxy-alias-test-'));
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
    upstream: http://127.0.0.1:${mockA.getPort()}/v1/chat/completions
    cost_per_1k_input: 0.001
    cost_per_1k_output: 0.002
  - name: model-b
    upstream: http://127.0.0.1:${mockB.getPort()}/v1/chat/completions
    cost_per_1k_input: 0.003
    cost_per_1k_output: 0.004
aliases:
  - name: current
    target: model-a
`.trim());

    process.env.CONFIG_PATH = configPath;
    server = new LLMServer();
    await server.start();
    proxyUrl = `http://127.0.0.1:${server.getPort()}`;

    // Seed an API key + admin auth header
    const db = Database(dbPath);
    const uuid = uuidv4();
    apiKey = `sk-${uuid}`;
    db.prepare(`INSERT INTO api_keys (key_prefix, key_value, name, is_active) VALUES (?, ?, 'test-key', 1)`)
      .run(uuid.slice(0, 8), apiKey);
    db.close();
    adminAuth = `Basic ${Buffer.from('test-admin:test-password').toString('base64')}`;
  });

  afterEach(async () => {
    await server.stop().catch(() => {});
    await mockA.stop().catch(() => {});
    await mockB.stop().catch(() => {});
    delete process.env.CONFIG_PATH;
  });

  it('exposes configured aliases publicly via GET /aliases', async () => {
    const res = await request(proxyUrl).get('/aliases');
    expect(res.status).toBe(200);
    expect(res.body.aliases).toEqual([{ name: 'current', target: 'model-a', updatedAt: expect.any(String) }]);
    expect(res.body.orchestrationEnabled).toBe(false);
  });

  it('routes alias "current" to the configured target model', async () => {
    mockA.setResponse({
      status: 200,
      body: {
        id: 'a',
        choices: [{ index: 0, message: { role: 'assistant', content: 'from A' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        model: 'model-a'
      }
    });

    const res = await request(proxyUrl)
      .post('/v1/chat/completions')
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ model: 'current', messages: [{ role: 'user', content: 'hi' }] });

    expect(res.status).toBe(200);
    expect(res.body.choices[0].message.content).toBe('from A');
    expect(mockA.getRequests().length).toBe(1);
    expect(mockB.getRequests().length).toBe(0);
  });

  it('follows a retargeted alias on subsequent requests', async () => {
    mockA.setResponse({ status: 200, body: { id: 'a', choices: [{ index: 0, message: { role: 'assistant', content: 'A' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }, model: 'model-a' } });
    mockB.setResponse({ status: 200, body: { id: 'b', choices: [{ index: 0, message: { role: 'assistant', content: 'B' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }, model: 'model-b' } });

    // Retarget the alias from A to B
    const flip = await request(proxyUrl)
      .put('/admin/aliases/current')
      .set('Authorization', adminAuth)
      .send({ target: 'model-b' });
    expect(flip.status).toBe(200);
    expect(flip.body.target).toBe('model-b');
    expect(flip.body.previousTarget).toBe('model-a');

    // Request to alias should now land on B
    mockA.clearRequests();
    mockB.clearRequests();
    const res = await request(proxyUrl)
      .post('/v1/chat/completions')
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ model: 'current', messages: [{ role: 'user', content: 'hi' }] });
    expect(res.status).toBe(200);
    expect(mockA.getRequests().length).toBe(0);
    expect(mockB.getRequests().length).toBe(1);
  });

  it('rejects retargeting to an unknown model', async () => {
    const res = await request(proxyUrl)
      .put('/admin/aliases/current')
      .set('Authorization', adminAuth)
      .send({ target: 'bogus-model' });
    expect(res.status).toBe(400);
  });

  it('requires admin auth to retarget', async () => {
    const res = await request(proxyUrl)
      .put('/admin/aliases/current')
      .send({ target: 'model-b' });
    expect(res.status).toBe(401);
  });

  it('meters usage against the resolved model, not the alias name', async () => {
    mockA.setResponse({ status: 200, body: {
      id: 'a', model: 'model-a',
      choices: [{ index: 0, message: { role: 'assistant', content: 'x' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 }
    }});

    await request(proxyUrl)
      .post('/v1/chat/completions')
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ model: 'current', messages: [{ role: 'user', content: 'hi' }] });

    // Give logUsage a moment to land
    await new Promise((r) => setTimeout(r, 50));

    const db = Database(dbPath, { readonly: true });
    const row = db.prepare('SELECT model, input_tokens, output_tokens FROM usage_logs ORDER BY id DESC LIMIT 1')
      .get() as { model: string; input_tokens: number; output_tokens: number } | undefined;
    db.close();

    expect(row?.model).toBe('model-a');
    expect(row?.input_tokens).toBe(5);
    expect(row?.output_tokens).toBe(7);
  });
});

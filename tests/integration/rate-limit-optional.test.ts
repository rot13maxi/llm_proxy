import { describe, it, expect, afterEach } from 'vitest';
import request from 'supertest';
import { writeFileSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import { MockUpstreamServer } from './fixtures/mock-upstream.js';
import { LLMServer } from '../../src/server.js';

/**
 * Rate limiting is opt-in. When there's no `rate_limits:` block in config AND
 * the API key has no per-key override, every request should pass without any
 * throttling bookkeeping.
 */
describe('Rate limiting is optional', () => {
  let mock: MockUpstreamServer;
  let server: LLMServer;
  let proxyUrl: string;
  let apiKey: string;

  async function startWithConfig(extra: string) {
    mock = new MockUpstreamServer();
    await mock.start(0);

    const tempDir = mkdtempSync(join(tmpdir(), 'llm-proxy-rl-optional-'));
    const dbPath = join(tempDir, 'test.db');
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
  - name: test-model
    upstream: http://127.0.0.1:${mock.getPort()}/v1/chat/completions
    cost_per_1k_input: 0.001
    cost_per_1k_output: 0.002
${extra}
`.trim());

    process.env.CONFIG_PATH = configPath;
    server = new LLMServer();
    await server.start();
    proxyUrl = `http://127.0.0.1:${server.getPort()}`;

    // Seed a key with NO per-key rate limits
    const db = Database(dbPath);
    const uuid = uuidv4();
    apiKey = `sk-${uuid}`;
    db.prepare(`INSERT INTO api_keys (key_prefix, key_value, name, is_active) VALUES (?, ?, 'unlimited', 1)`)
      .run(uuid.slice(0, 8), apiKey);
    db.close();

    mock.setResponse({
      status: 200,
      body: {
        id: 't', model: 'test-model',
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
      }
    });
  }

  afterEach(async () => {
    await server?.stop().catch(() => {});
    await mock?.stop().catch(() => {});
    delete process.env.CONFIG_PATH;
  });

  it('allows unlimited requests when no rate_limits section is in config', async () => {
    await startWithConfig('');  // No rate_limits: at all

    // 30 requests in quick succession — should all succeed
    for (let i = 0; i < 30; i++) {
      const res = await request(proxyUrl)
        .post('/v1/chat/completions')
        .set('Authorization', `Bearer ${apiKey}`)
        .send({ model: 'test-model', messages: [{ role: 'user', content: 'hello' }] });
      expect(res.status).toBe(200);
    }
  });

  it('allows unlimited requests when rate_limits.default is set but empty', async () => {
    // rate_limits block exists but neither limit is set — should still be unthrottled
    await startWithConfig(`
rate_limits:
  default: {}
`);

    for (let i = 0; i < 30; i++) {
      const res = await request(proxyUrl)
        .post('/v1/chat/completions')
        .set('Authorization', `Bearer ${apiKey}`)
        .send({ model: 'test-model', messages: [{ role: 'user', content: 'hello' }] });
      expect(res.status).toBe(200);
    }
  });

  it('still enforces per-key limits when config has no default rate_limits', async () => {
    await startWithConfig('');

    // Add a per-key rate limit after startup
    const db = Database(server.getPort() !== 0 ? (process.env.CONFIG_PATH as string).replace('config.yaml', 'test.db') : '');
    db.prepare(`UPDATE api_keys SET rate_limit_rpm = 2 WHERE key_value = ?`).run(apiKey);
    db.close();

    // First 2 should pass, 3rd should 429 (cache TTL on auth makes this a bit
    // fragile — the apiKey cache holds the old "no limit" state for 5 min. We
    // rotate the key to force a fresh auth read.)
    // For simplicity, restart the server so the auth cache is clean:
    await server.stop();
    server = new LLMServer();
    await server.start();
    proxyUrl = `http://127.0.0.1:${server.getPort()}`;

    const res1 = await request(proxyUrl)
      .post('/v1/chat/completions')
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ model: 'test-model', messages: [{ role: 'user', content: 'hi' }] });
    expect(res1.status).toBe(200);
    const res2 = await request(proxyUrl)
      .post('/v1/chat/completions')
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ model: 'test-model', messages: [{ role: 'user', content: 'hi' }] });
    expect(res2.status).toBe(200);
    const res3 = await request(proxyUrl)
      .post('/v1/chat/completions')
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ model: 'test-model', messages: [{ role: 'user', content: 'hi' }] });
    expect(res3.status).toBe(429);
  });
});

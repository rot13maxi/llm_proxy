import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { ProxyTestFixture } from './fixtures/proxy-fixture.js';
import Database from 'better-sqlite3';

describe('Rate Limiting', () => {
  let fixture: ProxyTestFixture;
  let db: Database.Database;

  beforeEach(async () => {
    // Create fixture with low rate limit (5 requests per minute)
    fixture = new ProxyTestFixture({ rateLimitRpm: 5, rateLimitTpm: 10000 });
    await fixture.setup();
    
    // Get direct DB access
    db = Database(fixture.getDbPath());
  });

  afterEach(async () => {
    db.close();
    await fixture.teardown();
  });

  it('should allow requests under the rate limit', async () => {
    fixture.getMockServer().setResponse({
      status: 200,
      body: {
        choices: [{ message: { content: 'test' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 }
      }
    });

    // Send 3 requests (under limit of 5)
    for (let i = 0; i < 3; i++) {
      const response = await request(fixture.getProxyUrl())
        .post('/v1/chat/completions')
        .set('Authorization', `Bearer ${fixture.getApiKey()}`)
        .send({ model: 'test-model', messages: [{ role: 'user', content: 'test' }] });

      expect(response.status).toBe(200);
    }
  });

  it('should enforce per-key rate limit (RPM)', async () => {
    fixture.getMockServer().setResponse({
      status: 200,
      body: {
        choices: [{ message: { content: 'test' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 }
      }
    });

    // Send 5 requests (at limit)
    for (let i = 0; i < 5; i++) {
      const response = await request(fixture.getProxyUrl())
        .post('/v1/chat/completions')
        .set('Authorization', `Bearer ${fixture.getApiKey()}`)
        .send({ model: 'test-model', messages: [{ role: 'user', content: 'test' }] });

      expect(response.status).toBe(200);
    }

    // 6th request should be rate limited
    const response6 = await request(fixture.getProxyUrl())
      .post('/v1/chat/completions')
      .set('Authorization', `Bearer ${fixture.getApiKey()}`)
      .send({ model: 'test-model', messages: [{ role: 'user', content: 'test' }] });

    expect(response6.status).toBe(429);
    expect(response6.body.error.code).toBe('rate_limit_exceeded');
  });

  it('should use per-key rate limits when configured', async () => {
    // Create a second API key with custom rate limit
    const { hash } = await import('@node-rs/argon2');
    const { v4: uuidv4 } = await import('uuid');
    
    const uuid = uuidv4();
    const fullKey = `sk-${uuid}`;
    const keyPrefix = uuid.slice(0, 8);
    const keyHash = await hash(fullKey, { memoryCost: 65536, timeCost: 2, parallelism: 1 });

    // Insert key with rate limit of 3 RPM
    db.prepare(`
      INSERT INTO api_keys (key_prefix, key_hash, name, is_active, rate_limit_rpm, rate_limit_tpm)
      VALUES (?, ?, 'limited-key', 1, 3, 10000)
    `).run(keyPrefix, keyHash);

    fixture.getMockServer().setResponse({
      status: 200,
      body: {
        choices: [{ message: { content: 'test' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 }
      }
    });

    // Send 3 requests (at this key's limit)
    for (let i = 0; i < 3; i++) {
      const response = await request(fixture.getProxyUrl())
        .post('/v1/chat/completions')
        .set('Authorization', `Bearer ${fullKey}`)
        .send({ model: 'test-model', messages: [{ role: 'user', content: 'test' }] });

      expect(response.status).toBe(200);
    }

    // 4th request should be rate limited for this key
    const response4 = await request(fixture.getProxyUrl())
      .post('/v1/chat/completions')
      .set('Authorization', `Bearer ${fullKey}`)
      .send({ model: 'test-model', messages: [{ role: 'user', content: 'test' }] });

    expect(response4.status).toBe(429);
    expect(response4.body.error.code).toBe('rate_limit_exceeded');

    // But original key should still work (different key, different limit)
    const responseOriginal = await request(fixture.getProxyUrl())
      .post('/v1/chat/completions')
      .set('Authorization', `Bearer ${fixture.getApiKey()}`)
      .send({ model: 'test-model', messages: [{ role: 'user', content: 'test' }] });

    expect(responseOriginal.status).toBe(200);
  });

  it('should return 429 with retry_after header', async () => {
    fixture.getMockServer().setResponse({
      status: 200,
      body: {
        choices: [{ message: { content: 'test' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 }
      }
    });

    // Exhaust the limit
    for (let i = 0; i < 5; i++) {
      await request(fixture.getProxyUrl())
        .post('/v1/chat/completions')
        .set('Authorization', `Bearer ${fixture.getApiKey()}`)
        .send({ model: 'test-model', messages: [{ role: 'user', content: 'test' }] });
    }

    // Next request should include retry_after
    const response = await request(fixture.getProxyUrl())
      .post('/v1/chat/completions')
      .set('Authorization', `Bearer ${fixture.getApiKey()}`)
      .send({ model: 'test-model', messages: [{ role: 'user', content: 'test' }] });

    expect(response.status).toBe(429);
    expect(response.body.error.retry_after).toBeDefined();
    expect(response.body.error.retry_after).toBeGreaterThan(0);
  });
});

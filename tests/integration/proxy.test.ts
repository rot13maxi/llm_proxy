import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { ProxyTestFixture } from './fixtures/proxy-fixture.js';
import Database from 'better-sqlite3';

describe('Proxy Integration', () => {
  let fixture: ProxyTestFixture;

  beforeEach(async () => {
    fixture = new ProxyTestFixture();
    await fixture.setup();
  });

  afterEach(async () => {
    await fixture.teardown();
  });

  it('should proxy request to upstream and return response', async () => {
    // Configure mock upstream response
    fixture.getMockServer().setResponse({
      status: 200,
      body: {
        id: 'test-response',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: 'Hello from mock' },
          finish_reason: 'stop'
        }],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 5,
          total_tokens: 15
        },
        model: 'test-model'
      }
    });

    // Send request through proxy
    const response = await request(fixture.getProxyUrl())
      .post('/v1/chat/completions')
      .set('Authorization', `Bearer ${fixture.getApiKey()}`)
      .set('Content-Type', 'application/json')
      .send({
        model: 'test-model',
        messages: [{ role: 'user', content: 'Hello' }]
      });

    // Validate response
    expect(response.status).toBe(200);
    expect(response.body.choices).toHaveLength(1);
    expect(response.body.choices[0].message.content).toBe('Hello from mock');
    expect(response.body.usage).toBeDefined();
  });

  it('should forward request to correct upstream URL', async () => {
    fixture.getMockServer().setResponse({
      status: 200,
      body: {
        choices: [{ message: { content: 'test' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 }
      }
    });

    await request(fixture.getProxyUrl())
      .post('/v1/chat/completions')
      .set('Authorization', `Bearer ${fixture.getApiKey()}`)
      .send({ model: 'test-model', messages: [{ role: 'user', content: 'test' }] });

    // Validate mock server received the request
    const requests = fixture.getMockServer().getRequests();
    expect(requests).toHaveLength(1);
    expect(requests[0].method).toBe('POST');
    expect(requests[0].body.model).toBe('test-model');
    expect(requests[0].body.messages).toHaveLength(1);
  });

  it('should log usage to database after request', async () => {
    fixture.getMockServer().setResponse({
      status: 200,
      body: {
        choices: [{ message: { content: 'test' } }],
        usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 }
      }
    });

    await request(fixture.getProxyUrl())
      .post('/v1/chat/completions')
      .set('Authorization', `Bearer ${fixture.getApiKey()}`)
      .send({ model: 'test-model', messages: [{ role: 'user', content: 'test' }] });

    // Check database for usage log
    const db = Database(fixture.getDbPath());
    const usage = db.prepare(`
      SELECT * FROM usage_logs ORDER BY id DESC LIMIT 1
    `).get() as {
      input_tokens: number;
      output_tokens: number;
      model: string;
      cost_usd: number;
    };

    expect(usage).toBeDefined();
    expect(usage.input_tokens).toBe(100);
    expect(usage.output_tokens).toBe(50);
    expect(usage.model).toBe('test-model');
    expect(usage.cost_usd).toBeGreaterThan(0);

    db.close();
  });

  it('should return 404 for unknown model', async () => {
    const response = await request(fixture.getProxyUrl())
      .post('/v1/chat/completions')
      .set('Authorization', `Bearer ${fixture.getApiKey()}`)
      .send({
        model: 'unknown-model',
        messages: [{ role: 'user', content: 'test' }]
      });

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('model_not_found');
  });

  it('should return 401 for invalid API key', async () => {
    const response = await request(fixture.getProxyUrl())
      .post('/v1/chat/completions')
      .set('Authorization', 'Bearer invalid-key')
      .send({
        model: 'test-model',
        messages: [{ role: 'user', content: 'test' }]
      });

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('invalid_api_key');
  });

  it('should return 401 for missing API key', async () => {
    const response = await request(fixture.getProxyUrl())
      .post('/v1/chat/completions')
      .send({
        model: 'test-model',
        messages: [{ role: 'user', content: 'test' }]
      });

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('missing_authorization');
  });

  it('should propagate upstream errors', async () => {
    fixture.getMockServer().setResponse({
      status: 500,
      body: { error: 'Upstream error' }
    });

    const response = await request(fixture.getProxyUrl())
      .post('/v1/chat/completions')
      .set('Authorization', `Bearer ${fixture.getApiKey()}`)
      .send({
        model: 'test-model',
        messages: [{ role: 'user', content: 'test' }]
      });

    expect(response.status).toBe(500);
  });

  it('should expose metrics endpoint', async () => {
    const response = await request(fixture.getProxyUrl())
      .get('/metrics');

    expect(response.status).toBe(200);
    expect(response.text).toContain('llm_proxy');
  });
});

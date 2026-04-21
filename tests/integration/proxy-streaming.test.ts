import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { ProxyTestFixture } from './fixtures/proxy-fixture.js';

describe('Streaming Proxy', () => {
  let fixture: ProxyTestFixture;
  let authHeader: string;

  beforeEach(async () => {
    fixture = new ProxyTestFixture();
    await fixture.setup();
    authHeader = `Bearer ${fixture.getApiKey()}`;
  });

  afterEach(async () => {
    await fixture.teardown();
  });

  it('should stream OpenAI completions', async () => {
    fixture.getMockServer().setStreamingResponse([
      '{"id":"chat-1","choices":[{"index":0,"delta":{"role":"assistant","content":"Hello"},"finish_reason":null}],"created":123,"model":"test-model"}',
      '{"id":"chat-1","choices":[{"index":0,"delta":{"content":" world"},"finish_reason":null}],"created":123,"model":"test-model"}',
      '{"id":"chat-1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"created":123,"model":"test-model"}',
      '{"id":"chat-1","usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}',
      '[DONE]'
    ]);

    const response = await request(fixture.getProxyUrl())
      .post('/v1/chat/completions')
      .set('Authorization', authHeader)
      .set('Content-Type', 'application/json')
      .send({
        model: 'test-model',
        messages: [{ role: 'user', content: 'Hello' }],
        stream: true
      });

    expect(response.type).toBe('text/event-stream');
    expect(response.text).toContain('Hello');
    expect(response.text).toContain('world');
    expect(response.text).toContain('finish_reason');
  });

  it('should handle streaming errors gracefully', async () => {
    fixture.getMockServer().setErrorResponse(500, 'Internal Server Error');

    const response = await request(fixture.getProxyUrl())
      .post('/v1/chat/completions')
      .set('Authorization', authHeader)
      .set('Content-Type', 'application/json')
      .send({
        model: 'test-model',
        messages: [{ role: 'user', content: 'Hello' }],
        stream: true
      });

    // Error responses should be 502 (bad gateway)
    expect(response.status).toBe(502);
  });

  it('should handle streaming interruption', async () => {
    fixture.getMockServer().setStreamingResponse([
      '{"id":"chat-1","choices":[{"index":0,"delta":{"content":"Partial"},"finish_reason":null}]}'
    ]);

    const response = await request(fixture.getProxyUrl())
      .post('/v1/chat/completions')
      .set('Authorization', authHeader)
      .set('Content-Type', 'application/json')
      .send({
        model: 'test-model',
        messages: [{ role: 'user', content: 'Test' }],
        stream: true
      });

    // Should still return partial data
    expect(response.text).toContain('Partial');
  });
});

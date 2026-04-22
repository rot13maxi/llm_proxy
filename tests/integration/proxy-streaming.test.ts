import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import Database from 'better-sqlite3';
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

  it('should meter tokens from streaming usage chunks', async () => {
    // Final chunk contains usage - this is what sglang/vllm emit when
    // stream_options.include_usage=true is set (the proxy sets it now).
    fixture.getMockServer().setStreamingResponse([
      '{"id":"c","choices":[{"index":0,"delta":{"role":"assistant","content":"Hi"},"finish_reason":null}]}',
      '{"id":"c","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
      '{"id":"c","choices":[],"usage":{"prompt_tokens":42,"completion_tokens":17,"total_tokens":59}}',
      '[DONE]'
    ]);

    await request(fixture.getProxyUrl())
      .post('/v1/chat/completions')
      .set('Authorization', `Bearer ${fixture.getApiKey()}`)
      .set('Content-Type', 'application/json')
      .send({
        model: 'test-model',
        messages: [{ role: 'user', content: 'Hi' }],
        stream: true
      });

    // Give the async logUsage call a moment to land in SQLite
    await new Promise((r) => setTimeout(r, 50));

    const db = Database(fixture.getDbPath(), { readonly: true });
    const row = db.prepare(
      'SELECT input_tokens, output_tokens FROM usage_logs ORDER BY id DESC LIMIT 1'
    ).get() as { input_tokens: number; output_tokens: number } | undefined;
    db.close();

    expect(row).toBeDefined();
    expect(row!.input_tokens).toBe(42);
    expect(row!.output_tokens).toBe(17);
  });

  it('should forward stream_options.include_usage to upstream so usage is emitted', async () => {
    fixture.getMockServer().clearRequests();
    fixture.getMockServer().setStreamingResponse([
      '{"id":"c","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}',
      '[DONE]'
    ]);

    await request(fixture.getProxyUrl())
      .post('/v1/chat/completions')
      .set('Authorization', `Bearer ${fixture.getApiKey()}`)
      .set('Content-Type', 'application/json')
      .send({
        model: 'test-model',
        messages: [{ role: 'user', content: 'x' }],
        stream: true
      });

    const upstreamReq = fixture.getMockServer().getRequests().find((r) => r.method === 'POST');
    expect(upstreamReq).toBeDefined();
    const body = upstreamReq!.body as { stream_options?: { include_usage?: boolean } };
    expect(body.stream_options?.include_usage).toBe(true);
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

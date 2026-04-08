import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import Database from 'better-sqlite3';
import { ProxyTestFixture } from './fixtures/proxy-fixture.js';

// Wait for the fire-and-forget metering write triggered after a streamed
// response finishes. Polls instead of using a fixed sleep.
async function waitForUsageLog(dbPath: string, timeoutMs = 1000): Promise<{
  input_tokens: number;
  output_tokens: number;
  model: string;
  cost_usd: number;
} | null> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const db = Database(dbPath);
    const row = db.prepare('SELECT * FROM usage_logs ORDER BY id DESC LIMIT 1').get() as
      | { input_tokens: number; output_tokens: number; model: string; cost_usd: number }
      | undefined;
    db.close();
    if (row) return row;
    await new Promise(r => setTimeout(r, 20));
  }
  return null;
}

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

  it('should meter streaming requests using upstream usage chunk', async () => {
    fixture.getMockServer().setStreamingResponse([
      '{"id":"chat-1","choices":[{"index":0,"delta":{"role":"assistant","content":"Hello"},"finish_reason":null}],"created":123,"model":"test-model"}',
      '{"id":"chat-1","choices":[{"index":0,"delta":{"content":" world"},"finish_reason":null}],"created":123,"model":"test-model"}',
      '{"id":"chat-1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"created":123,"model":"test-model"}',
      '{"id":"chat-1","choices":[],"usage":{"prompt_tokens":42,"completion_tokens":17,"total_tokens":59}}',
      '[DONE]'
    ]);

    await request(fixture.getProxyUrl())
      .post('/v1/chat/completions')
      .set('Authorization', authHeader)
      .set('Content-Type', 'application/json')
      .send({
        model: 'test-model',
        messages: [{ role: 'user', content: 'Hello' }],
        stream: true
      });

    const usage = await waitForUsageLog(fixture.getDbPath());
    expect(usage).not.toBeNull();
    expect(usage!.input_tokens).toBe(42);
    expect(usage!.output_tokens).toBe(17);
    expect(usage!.model).toBe('test-model');
    expect(usage!.cost_usd).toBeGreaterThan(0);
  });

  it('should request stream usage from upstream via stream_options', async () => {
    fixture.getMockServer().setStreamingResponse([
      '{"id":"chat-1","choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":"stop"}]}',
      '{"id":"chat-1","usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}',
      '[DONE]'
    ]);

    await request(fixture.getProxyUrl())
      .post('/v1/chat/completions')
      .set('Authorization', authHeader)
      .set('Content-Type', 'application/json')
      .send({
        model: 'test-model',
        messages: [{ role: 'user', content: 'Hello' }],
        stream: true
      });

    const upstreamRequests = fixture.getMockServer().getRequests();
    expect(upstreamRequests).toHaveLength(1);
    const body = upstreamRequests[0].body as { stream_options?: { include_usage?: boolean } };
    expect(body.stream_options).toBeDefined();
    expect(body.stream_options!.include_usage).toBe(true);
  });

  it('should fall back to estimated usage when upstream omits usage chunk', async () => {
    // No usage chunk in the stream — exercises the character-based fallback.
    fixture.getMockServer().setStreamingResponse([
      '{"id":"chat-1","choices":[{"index":0,"delta":{"role":"assistant","content":"Hello"},"finish_reason":null}],"created":123,"model":"test-model"}',
      '{"id":"chat-1","choices":[{"index":0,"delta":{"content":" world"},"finish_reason":null}],"created":123,"model":"test-model"}',
      '{"id":"chat-1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"created":123,"model":"test-model"}',
      '[DONE]'
    ]);

    await request(fixture.getProxyUrl())
      .post('/v1/chat/completions')
      .set('Authorization', authHeader)
      .set('Content-Type', 'application/json')
      .send({
        model: 'test-model',
        messages: [{ role: 'user', content: 'Hello there friend' }],
        stream: true
      });

    const usage = await waitForUsageLog(fixture.getDbPath());
    expect(usage).not.toBeNull();
    // Should NOT be zero — that's the bug we're fixing.
    expect(usage!.input_tokens).toBeGreaterThan(0);
    expect(usage!.output_tokens).toBeGreaterThan(0);
    expect(usage!.cost_usd).toBeGreaterThan(0);
  });

  it('should meter streaming usage even when SSE events span multiple chunks', async () => {
    // Build a single very long SSE event so the upstream sender splits it
    // across multiple TCP write events. The previous parser would lose this
    // because it parsed each socket chunk independently.
    const longContent = 'x'.repeat(8 * 1024);
    fixture.getMockServer().setStreamingResponse([
      `{"id":"chat-1","choices":[{"index":0,"delta":{"role":"assistant","content":"${longContent}"},"finish_reason":null}],"created":123,"model":"test-model"}`,
      '{"id":"chat-1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"created":123,"model":"test-model"}',
      '{"id":"chat-1","choices":[],"usage":{"prompt_tokens":7,"completion_tokens":3,"total_tokens":10}}',
      '[DONE]'
    ]);

    await request(fixture.getProxyUrl())
      .post('/v1/chat/completions')
      .set('Authorization', authHeader)
      .set('Content-Type', 'application/json')
      .send({
        model: 'test-model',
        messages: [{ role: 'user', content: 'Hello' }],
        stream: true
      });

    const usage = await waitForUsageLog(fixture.getDbPath());
    expect(usage).not.toBeNull();
    expect(usage!.input_tokens).toBe(7);
    expect(usage!.output_tokens).toBe(3);
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

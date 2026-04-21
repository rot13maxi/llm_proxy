import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { ProxyTestFixture } from './fixtures/proxy-fixture.js';

describe('Error Handling', () => {
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

  describe('Authentication Errors', () => {
    it('should return 401 for missing auth header', async () => {
      const response = await request(fixture.getProxyUrl())
        .post('/v1/chat/completions')
        .set('Content-Type', 'application/json')
        .send({
          model: 'test-model',
          messages: [{ role: 'user', content: 'Test' }]
        });

      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe('missing_authorization');
    });

    it('should return 401 for invalid API key', async () => {
      const response = await request(fixture.getProxyUrl())
        .post('/v1/chat/completions')
        .set('Authorization', 'Bearer sk-invalid-key-123')
        .set('Content-Type', 'application/json')
        .send({
          model: 'test-model',
          messages: [{ role: 'user', content: 'Test' }]
        });

      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe('invalid_api_key');
    });

    it('should return 401 for malformed auth header', async () => {
      const response = await request(fixture.getProxyUrl())
        .post('/v1/chat/completions')
        .set('Authorization', 'Invalid format')
        .set('Content-Type', 'application/json')
        .send({
          model: 'test-model',
          messages: [{ role: 'user', content: 'Test' }]
        });

      expect(response.status).toBe(401);
    });
  });

  describe('Request Validation Errors', () => {
    it('should return 400 for missing model', async () => {
      const response = await request(fixture.getProxyUrl())
        .post('/v1/chat/completions')
        .set('Authorization', authHeader)
        .set('Content-Type', 'application/json')
        .send({
          messages: [{ role: 'user', content: 'Test' }]
        });

      expect(response.status).toBe(400);
      expect(response.body.error.message).toBe('model is required');
    });

    it('should return 400 for missing messages', async () => {
      const response = await request(fixture.getProxyUrl())
        .post('/v1/chat/completions')
        .set('Authorization', authHeader)
        .set('Content-Type', 'application/json')
        .send({
          model: 'test-model'
        });

      expect(response.status).toBe(400);
      expect(response.body.error.message).toBe('messages array is required');
    });

    it('should return 400 for non-array messages', async () => {
      const response = await request(fixture.getProxyUrl())
        .post('/v1/chat/completions')
        .set('Authorization', authHeader)
        .set('Content-Type', 'application/json')
        .send({
          model: 'test-model',
          messages: { role: 'user', content: 'Test' }
        });

      expect(response.status).toBe(400);
    });

    it('should return 404 for unknown model', async () => {
      fixture.getMockServer().setErrorResponse(404, 'Model not found');

      const response = await request(fixture.getProxyUrl())
        .post('/v1/chat/completions')
        .set('Authorization', authHeader)
        .set('Content-Type', 'application/json')
        .send({
          model: 'non-existent-model',
          messages: [{ role: 'user', content: 'Test' }]
        });

      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe('model_not_found');
    });
  });

  describe('Upstream Errors', () => {
    it('should return 502 for upstream server errors', async () => {
      fixture.getMockServer().setErrorResponse(500, 'Internal Server Error');

      const response = await request(fixture.getProxyUrl())
        .post('/v1/chat/completions')
        .set('Authorization', authHeader)
        .set('Content-Type', 'application/json')
        .send({
          model: 'test-model',
          messages: [{ role: 'user', content: 'Test' }]
        });

      expect(response.status).toBe(502);
      expect(response.body.error.code).toBe('upstream_error');
    });

    it('should return 502 for upstream connection failures', async () => {
      // Simulate upstream being unavailable
      fixture.getMockServer().stop();

      const response = await request(fixture.getProxyUrl())
        .post('/v1/chat/completions')
        .set('Authorization', authHeader)
        .set('Content-Type', 'application/json')
        .send({
          model: 'test-model',
          messages: [{ role: 'user', content: 'Test' }]
        });

      expect(response.status).toBe(502);
    });

    it('should handle upstream timeout', async () => {
      fixture.getMockServer().setSlowResponse(5000); // 5 second delay

      const response = await request(fixture.getProxyUrl())
        .post('/v1/chat/completions')
        .set('Authorization', authHeader)
        .set('Content-Type', 'application/json')
        .send({
          model: 'test-model',
          messages: [{ role: 'user', content: 'Test' }]
        });

      // Should eventually timeout or error
      expect([502, 504]).toContain(response.status);
    });
  });

  describe('Rate Limiting Errors', () => {
    it('should return 429 when rate limit exceeded', async () => {
      // Create a key with very low rate limit
      const lowLimitFixture = new ProxyTestFixture({ rateLimitRpm: 2 });
      await lowLimitFixture.setup();
      const lowLimitAuth = `Bearer ${lowLimitFixture.getApiKey()}`;

      // Make 2 requests (at limit)
      for (let i = 0; i < 2; i++) {
        const response = await request(lowLimitFixture.getProxyUrl())
          .post('/v1/chat/completions')
          .set('Authorization', lowLimitAuth)
          .set('Content-Type', 'application/json')
          .send({
            model: 'test-model',
            messages: [{ role: 'user', content: 'Test' }]
          });
        expect(response.status).toBe(200);
      }

      // Third request should be rate limited
      const response = await request(lowLimitFixture.getProxyUrl())
        .post('/v1/chat/completions')
        .set('Authorization', lowLimitAuth)
        .set('Content-Type', 'application/json')
        .send({
          model: 'test-model',
          messages: [{ role: 'user', content: 'Test' }]
        });

      expect(response.status).toBe(429);
      expect(response.body.error.code).toBe('rate_limit_exceeded');
      expect(response.body.error.retry_after).toBeDefined();
      
      await lowLimitFixture.teardown();
    });

    it('should include current usage in 429 response', async () => {
      const lowLimitFixture = new ProxyTestFixture({ rateLimitRpm: 1 });
      await lowLimitFixture.setup();
      const lowLimitAuth = `Bearer ${lowLimitFixture.getApiKey()}`;

      // First request
      await request(lowLimitFixture.getProxyUrl())
        .post('/v1/chat/completions')
        .set('Authorization', lowLimitAuth)
        .set('Content-Type', 'application/json')
        .send({
          model: 'test-model',
          messages: [{ role: 'user', content: 'Test' }]
        });

      // Second request should be rate limited with usage info
      const response = await request(lowLimitFixture.getProxyUrl())
        .post('/v1/chat/completions')
        .set('Authorization', lowLimitAuth)
        .set('Content-Type', 'application/json')
        .send({
          model: 'test-model',
          messages: [{ role: 'user', content: 'Test' }]
        });

      expect(response.status).toBe(429);
      expect(response.body.limit).toBeDefined();
      expect(response.body.current).toBeDefined();
      
      await lowLimitFixture.teardown();
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty message content', async () => {
      fixture.getMockServer().setResponse({
        status: 200,
        body: {
          id: 'chat-empty',
          choices: [{
            index: 0,
            message: { role: 'assistant', content: 'Response' },
            finish_reason: 'stop'
          }],
          usage: { prompt_tokens: 0, completion_tokens: 5, total_tokens: 5 }
        }
      });

      const response = await request(fixture.getProxyUrl())
        .post('/v1/chat/completions')
        .set('Authorization', authHeader)
        .set('Content-Type', 'application/json')
        .send({
          model: 'test-model',
          messages: [{ role: 'user', content: '' }]
        });

      expect(response.status).toBe(200);
    });

    it('should handle very long messages', async () => {
      const longContent = 'x'.repeat(10000); // 10k characters
      
      fixture.getMockServer().setResponse({
        status: 200,
        body: {
          id: 'chat-long',
          choices: [{
            index: 0,
            message: { role: 'assistant', content: 'Response' },
            finish_reason: 'stop'
          }],
          usage: { prompt_tokens: 1000, completion_tokens: 5, total_tokens: 1005 }
        }
      });

      const response = await request(fixture.getProxyUrl())
        .post('/v1/chat/completions')
        .set('Authorization', authHeader)
        .set('Content-Type', 'application/json')
        .send({
          model: 'test-model',
          messages: [{ role: 'user', content: longContent }]
        });

      expect(response.status).toBe(200);
    });

    it('should handle special characters in messages', async () => {
      fixture.getMockServer().setResponse({
        status: 200,
        body: {
          id: 'chat-special',
          choices: [{
            index: 0,
            message: { role: 'assistant', content: 'Response' },
            finish_reason: 'stop'
          }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
        }
      });

      const response = await request(fixture.getProxyUrl())
        .post('/v1/chat/completions')
        .set('Authorization', authHeader)
        .set('Content-Type', 'application/json')
        .send({
          model: 'test-model',
          messages: [{
            role: 'user',
            content: 'Hello 世界 🌍 <script>alert("xss")</script> "quotes" \n newlines'
          }]
        });

      expect(response.status).toBe(200);
    });

    it('should handle multiple messages in conversation', async () => {
      fixture.getMockServer().setResponse({
        status: 200,
        body: {
          id: 'chat-multi',
          choices: [{
            index: 0,
            message: { role: 'assistant', content: 'Fourth response' },
            finish_reason: 'stop'
          }],
          usage: { prompt_tokens: 40, completion_tokens: 5, total_tokens: 45 }
        }
      });

      const response = await request(fixture.getProxyUrl())
        .post('/v1/chat/completions')
        .set('Authorization', authHeader)
        .set('Content-Type', 'application/json')
        .send({
          model: 'test-model',
          messages: [
            { role: 'system', content: 'You are helpful' },
            { role: 'user', content: 'Hello' },
            { role: 'assistant', content: 'Hi there' },
            { role: 'user', content: 'How are you?' }
          ]
        });

      expect(response.status).toBe(200);
      expect(response.body.choices[0].message.content).toBe('Fourth response');
    });

    it('should handle invalid JSON in request body', async () => {
      const response = await request(fixture.getProxyUrl())
        .post('/v1/chat/completions')
        .set('Authorization', authHeader)
        .set('Content-Type', 'application/json')
        .send('{ invalid json }');

      // Express json middleware will return 400 for invalid JSON
      expect([400, 413]).toContain(response.status);
    });
  });

  describe('Health Check', () => {
    it('should return healthy status', async () => {
      const response = await request(fixture.getProxyUrl())
        .get('/health');

      expect(response.status).toBe(200);
      expect(response.body.status).toBe('ok');
      expect(response.body.timestamp).toBeDefined();
    });

    it('should be accessible without authentication', async () => {
      const response = await request(fixture.getProxyUrl())
        .get('/health');

      expect(response.status).toBe(200);
    });
  });

  describe('Metrics Endpoint', () => {
    it('should return Prometheus metrics', async () => {
      const response = await request(fixture.getProxyUrl())
        .get('/metrics');

      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toContain('text/plain');
      expect(response.text).toContain('llm_proxy_');
    });

    it('should be accessible without authentication', async () => {
      const response = await request(fixture.getProxyUrl())
        .get('/metrics');

      expect(response.status).toBe(200);
    });
  });
});

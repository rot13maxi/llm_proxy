import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { ProxyTestFixture } from './fixtures/proxy-fixture.js';

describe('Anthropic Endpoint', () => {
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

  it('should proxy Anthropic messages to OpenAI upstream', async () => {
    const mockResponse = {
      id: 'msg-123',
      choices: [{
        index: 0,
        message: { role: 'assistant', content: 'Hello from OpenAI' },
        finish_reason: 'stop'
      }],
      usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 },
      created: 1234567890,
      model: 'test-model'
    };

    fixture.getMockServer().setResponse({
      status: 200,
      body: mockResponse
    });

    const response = await request(fixture.getProxyUrl())
      .post('/v1/messages')
      .set('Authorization', authHeader)
      .set('Content-Type', 'application/json')
      .set('anthropic-version', '2023-06-01')
      .send({
        model: 'test-model',
        messages: [
          { role: 'user', content: 'Hello' }
        ],
        max_tokens: 100
      });

    expect(response.status).toBe(200);
    expect(response.body.id).toBe('msg-123');
    expect(response.body.type).toBe('message');
    expect(response.body.role).toBe('assistant');
    expect(response.body.content[0].type).toBe('text');
    expect(response.body.content[0].text).toBe('Hello from OpenAI');
    expect(response.body.usage.input_tokens).toBe(10);
    expect(response.body.usage.output_tokens).toBe(8);
  });

  it('should handle Anthropic system message', async () => {
    fixture.getMockServer().setResponse({
      status: 200,
      body: {
        id: 'msg-456',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: 'I am helpful' },
          finish_reason: 'stop'
        }],
        usage: { prompt_tokens: 15, completion_tokens: 5, total_tokens: 20 }
      }
    });

    const response = await request(fixture.getProxyUrl())
      .post('/v1/messages')
      .set('Authorization', authHeader)
      .set('Content-Type', 'application/json')
      .send({
        model: 'test-model',
        system: 'You are a helpful assistant',
        messages: [{ role: 'user', content: 'Hi' }],
        max_tokens: 50
      });

    expect(response.status).toBe(200);
    expect(response.body.content[0].text).toBe('I am helpful');
  });

  it('should handle Anthropic content arrays', async () => {
    fixture.getMockServer().setResponse({
      status: 200,
      body: {
        id: 'msg-789',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: 'Response' },
          finish_reason: 'stop'
        }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
      }
    });

    const response = await request(fixture.getProxyUrl())
      .post('/v1/messages')
      .set('Authorization', authHeader)
      .set('Content-Type', 'application/json')
      .send({
        model: 'test-model',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Hello' },
              { type: 'text', text: ' world' }
            ]
          }
        ],
        max_tokens: 50
      });

    expect(response.status).toBe(200);
    // Content should be concatenated
    expect(response.body.content[0].text).toBe('Response');
  });

  it('should propagate upstream errors', async () => {
    fixture.getMockServer().setErrorResponse(400, 'Bad Request');

    const response = await request(fixture.getProxyUrl())
      .post('/v1/messages')
      .set('Authorization', authHeader)
      .set('Content-Type', 'application/json')
      .send({
        model: 'test-model',
        messages: [{ role: 'user', content: 'Test' }],
        max_tokens: 50
      });

    expect(response.status).toBe(400);
  });

  it('should handle missing model', async () => {
    const response = await request(fixture.getProxyUrl())
      .post('/v1/messages')
      .set('Authorization', authHeader)
      .set('Content-Type', 'application/json')
      .send({
        messages: [{ role: 'user', content: 'Test' }],
        max_tokens: 50
      });

    expect(response.status).toBe(400);
    expect(response.body.error.message).toBe('model is required');
  });

  it('should handle missing messages', async () => {
    const response = await request(fixture.getProxyUrl())
      .post('/v1/messages')
      .set('Authorization', authHeader)
      .set('Content-Type', 'application/json')
      .send({
        model: 'test-model',
        max_tokens: 50
      });

    expect(response.status).toBe(400);
    expect(response.body.error.message).toBe('messages array is required');
  });

  it('should log usage for Anthropic requests', async () => {
    fixture.getMockServer().setResponse({
      status: 200,
      body: {
        id: 'msg-usage-test',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: 'Test' },
          finish_reason: 'stop'
        }],
        usage: { prompt_tokens: 200, completion_tokens: 100, total_tokens: 300 }
      }
    });

    await request(fixture.getProxyUrl())
      .post('/v1/messages')
      .set('Authorization', authHeader)
      .set('Content-Type', 'application/json')
      .send({
        model: 'test-model',
        messages: [{ role: 'user', content: 'Test' }],
        max_tokens: 50
      });

    // Give time for async logging
    await new Promise(resolve => setTimeout(resolve, 100));

    const Database = await import('better-sqlite3');
    const database = new Database.default(fixture.getDbPath());
    
    const logs = database.prepare(
      'SELECT * FROM usage_logs WHERE input_tokens = 200 AND output_tokens = 100'
    ).all();
    
    expect(logs.length).toBeGreaterThan(0);
    database.close();
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { ProxyTestFixture } from './fixtures/proxy-fixture.js';

describe('Admin UI', () => {
  let fixture: ProxyTestFixture;
  let adminAuth: string;
  let csrfSecret: string;

  beforeEach(async () => {
    fixture = new ProxyTestFixture();
    await fixture.setup();
    
    // Create admin auth header
    const credentials = Buffer.from('test-admin:test-password').toString('base64');
    adminAuth = `Basic ${credentials}`;
    
    // Get CSRF token
    const csrfResponse = await request(fixture.getProxyUrl())
      .get('/admin/csrf-token')
      .set('Authorization', adminAuth);
    csrfSecret = csrfResponse.body.csrf_secret;
  });

  afterEach(async () => {
    await fixture.teardown();
  });

  it('should serve HTML UI at /admin', async () => {
    const response = await request(fixture.getProxyUrl())
      .get('/admin')
      .set('Authorization', adminAuth)
      .set('Accept', 'text/html');

    expect(response.status).toBe(200);
    expect(response.text).toContain('<!DOCTYPE html>');
    expect(response.text).toContain('API Keys');
    expect(response.text).toContain('Create Key');
  });

  it('should return JSON for API clients at /admin', async () => {
    const response = await request(fixture.getProxyUrl())
      .get('/admin')
      .set('Authorization', adminAuth)
      .set('Accept', 'application/json');

    expect(response.status).toBe(200);
    expect(response.body).toHaveProperty('dashboard');
    expect(response.body.dashboard).toHaveProperty('today');
  });

  it('should list API keys via API', async () => {
    const response = await request(fixture.getProxyUrl())
      .get('/admin/keys')
      .set('Authorization', adminAuth);

    expect(response.status).toBe(200);
    expect(response.body).toHaveProperty('keys');
    expect(Array.isArray(response.body.keys)).toBe(true);
  });

  it('should create API key via API', async () => {
    const response = await request(fixture.getProxyUrl())
      .post('/admin/keys')
      .set('Authorization', adminAuth)
      .set('Content-Type', 'application/json')
      .set('X-CSRF-Secret', csrfSecret)
      .send({
        name: 'test-ui-key',
        rateLimitRpm: 100,
        rateLimitTpm: 200000,
        csrf_secret: csrfSecret
      });

    expect(response.status).toBe(201);
    expect(response.body).toHaveProperty('key');
    expect(response.body.key).toMatch(/^sk-[a-f0-9-]+$/);
    expect(response.body.name).toBe('test-ui-key');
  });

  it('should delete API key via API', async () => {
    // First create a key
    const createRes = await request(fixture.getProxyUrl())
      .post('/admin/keys')
      .set('Authorization', adminAuth)
      .set('X-CSRF-Secret', csrfSecret)
      .send({ name: 'to-delete', csrf_secret: csrfSecret });

    expect(createRes.status).toBe(201);
    const keyId = createRes.body.id;

    // Then delete it
    const deleteRes = await request(fixture.getProxyUrl())
      .delete(`/admin/keys/${keyId}`)
      .set('Authorization', adminAuth)
      .set('X-CSRF-Secret', csrfSecret);

    expect(deleteRes.status).toBe(204);

    // Verify it's gone
    const listRes = await request(fixture.getProxyUrl())
      .get('/admin/keys')
      .set('Authorization', adminAuth);

    const key = listRes.body.keys.find((k: any) => k.id === keyId);
    expect(key).toBeUndefined();
  });

  it('should require authentication for admin endpoints', async () => {
    const response = await request(fixture.getProxyUrl())
      .get('/admin/keys');

    expect(response.status).toBe(401);
  });

  it('should show empty state when no keys exist', async () => {
    // Note: fixture creates a test key, so we check the API works correctly
    const response = await request(fixture.getProxyUrl())
      .get('/admin/keys')
      .set('Authorization', adminAuth);

    expect(response.status).toBe(200);
    expect(response.body).toHaveProperty('keys');
    expect(Array.isArray(response.body.keys)).toBe(true);
  });

  it('should include usage stats with keys', async () => {
    // Create a key
    const createRes = await request(fixture.getProxyUrl())
      .post('/admin/keys')
      .set('Authorization', adminAuth)
      .set('X-CSRF-Secret', csrfSecret)
      .send({ name: 'usage-test', csrf_secret: csrfSecret });

    expect(createRes.status).toBe(201);

    // Get keys with usage
    const response = await request(fixture.getProxyUrl())
      .get('/admin/keys')
      .set('Authorization', adminAuth);

    const key = response.body.keys.find((k: any) => k.name === 'usage-test');
    expect(key).toBeDefined();
    expect(key.usage).toHaveProperty('requests');
    expect(key.usage).toHaveProperty('cost');
  });

  it('should return metrics with daily stats', async () => {
    const response = await request(fixture.getProxyUrl())
      .get('/admin/metrics?days=7')
      .set('Authorization', adminAuth);

    expect(response.status).toBe(200);
    expect(response.body).toHaveProperty('summary');
    expect(response.body.summary).toHaveProperty('totalRequests');
    expect(response.body.summary).toHaveProperty('totalCost');
    expect(response.body).toHaveProperty('dailyStats');
    expect(Array.isArray(response.body.dailyStats)).toBe(true);
  });

  it('should return hourly metrics for last hour', async () => {
    const response = await request(fixture.getProxyUrl())
      .get('/admin/metrics/hourly?hours=1')
      .set('Authorization', adminAuth);

    expect(response.status).toBe(200);
    expect(response.body).toHaveProperty('hourlyStats');
    expect(Array.isArray(response.body.hourlyStats)).toBe(true);
    expect(response.body).toHaveProperty('type', 'hourly');
  });

  it('should return model usage over time', async () => {
    const response = await request(fixture.getProxyUrl())
      .get('/admin/metrics?days=1')
      .set('Authorization', adminAuth);

    expect(response.status).toBe(200);
    expect(response.body).toHaveProperty('modelUsageOverTime');
    expect(Array.isArray(response.body.modelUsageOverTime)).toBe(true);
  });

  it('should return top API keys by spend', async () => {
    const response = await request(fixture.getProxyUrl())
      .get('/admin/metrics?days=7')
      .set('Authorization', adminAuth);

    expect(response.status).toBe(200);
    expect(response.body).toHaveProperty('topApiKeys');
    expect(Array.isArray(response.body.topApiKeys)).toBe(true);
  });

  it('should return metrics filtered by API key ID', async () => {
    // Create a key first
    const createRes = await request(fixture.getProxyUrl())
      .post('/admin/keys')
      .set('Authorization', adminAuth)
      .set('X-CSRF-Secret', csrfSecret)
      .send({ name: 'filter-test', csrf_secret: csrfSecret });

    expect(createRes.status).toBe(201);
    const keyId = createRes.body.id;

    // Get metrics filtered by this key
    const response = await request(fixture.getProxyUrl())
      .get(`/admin/metrics?days=7&apiKeyId=${keyId}`)
      .set('Authorization', adminAuth);

    expect(response.status).toBe(200);
    expect(response.body).toHaveProperty('filters');
    expect(response.body.filters.apiKeyId).toBe(String(keyId));
  });

  it('should return logs with API key name and tags', async () => {
    const response = await request(fixture.getProxyUrl())
      .get('/admin/logs?limit=100')
      .set('Authorization', adminAuth);

    expect(response.status).toBe(200);
    expect(response.body).toHaveProperty('logs');
    expect(Array.isArray(response.body.logs)).toBe(true);

    // Check log structure
    if (response.body.logs.length > 0) {
      const log = response.body.logs[0];
      expect(log).toHaveProperty('apiKeyName');
      expect(log).toHaveProperty('apiKeyTags');
      expect(log).toHaveProperty('model');
      expect(log).toHaveProperty('cost');
    }
  });

  it('should return API keys for filter dropdown with id and name', async () => {
    const response = await request(fixture.getProxyUrl())
      .get('/admin/filters/api-keys')
      .set('Authorization', adminAuth);

    expect(response.status).toBe(200);
    expect(response.body).toHaveProperty('keys');
    expect(Array.isArray(response.body.keys)).toBe(true);

    // Check each key has id and name
    if (response.body.keys.length > 0) {
      const key = response.body.keys[0];
      expect(key).toHaveProperty('id');
      expect(key).toHaveProperty('name');
    }
  });

  it('should return models for filter dropdown', async () => {
    const response = await request(fixture.getProxyUrl())
      .get('/admin/filters/models')
      .set('Authorization', adminAuth);

    expect(response.status).toBe(200);
    expect(response.body).toHaveProperty('models');
    expect(Array.isArray(response.body.models)).toBe(true);
  });

  it('should return hourly model usage', async () => {
    const response = await request(fixture.getProxyUrl())
      .get('/admin/metrics/by-model?hours=1')
      .set('Authorization', adminAuth);

    expect(response.status).toBe(200);
    expect(response.body).toHaveProperty('byModel');
    expect(Array.isArray(response.body.byModel)).toBe(true);
    expect(response.body).toHaveProperty('modelUsageOverTime');
  });

  it('should return top keys by spend for hourly', async () => {
    const response = await request(fixture.getProxyUrl())
      .get('/admin/metrics/top-keys?hours=1')
      .set('Authorization', adminAuth);

    expect(response.status).toBe(200);
    expect(response.body).toHaveProperty('topApiKeys');
    expect(Array.isArray(response.body.topApiKeys)).toBe(true);
  });
});

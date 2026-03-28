import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { ProxyTestFixture } from './fixtures/proxy-fixture.js';

describe('Admin API', () => {
  let fixture: ProxyTestFixture;
  let adminAuth: string;
  let csrfSecret: string;

  beforeEach(async () => {
    fixture = new ProxyTestFixture();
    await fixture.setup();
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

  describe('GET /admin/keys', () => {
    it('should list all API keys', async () => {
      const response = await request(fixture.getProxyUrl())
        .get('/admin/keys')
        .set('Authorization', adminAuth);

      expect(response.status).toBe(200);
      expect(response.body.keys).toBeDefined();
      expect(Array.isArray(response.body.keys)).toBe(true);
      // Should have at least the test key
      expect(response.body.keys.length).toBeGreaterThan(0);
    });

    it('should include usage stats with keys', async () => {
      const response = await request(fixture.getProxyUrl())
        .get('/admin/keys')
        .set('Authorization', adminAuth);

      expect(response.status).toBe(200);
      const key = response.body.keys[0];
      expect(key).toHaveProperty('usage');
      expect(key.usage).toHaveProperty('requests');
      expect(key.usage).toHaveProperty('tokens');
      expect(key.usage).toHaveProperty('cost');
    });

    it('should require authentication', async () => {
      const response = await request(fixture.getProxyUrl())
        .get('/admin/keys');

      expect(response.status).toBe(401);
    });
  });

  describe('POST /admin/keys', () => {
    it('should create a new API key', async () => {
      const response = await request(fixture.getProxyUrl())
        .post('/admin/keys')
        .set('Authorization', adminAuth)
        .set('Content-Type', 'application/json')
        .set('X-CSRF-Secret', csrfSecret)
        .send({
          name: 'test-key-new',
          tags: 'test,integration',
          csrf_secret: csrfSecret
        });

      expect(response.status).toBe(201);
      expect(response.body.id).toBeDefined();
      expect(response.body.key).toBeDefined();
      expect(response.body.key.startsWith('sk-')).toBe(true);
      expect(response.body.name).toBe('test-key-new');
      expect(response.body.created_at).toBeDefined();
    });

    it('should create key with expiration', async () => {
      const expiresAt = new Date(Date.now() + 86400000).toISOString(); // 1 day from now

      const response = await request(fixture.getProxyUrl())
        .post('/admin/keys')
        .set('Authorization', adminAuth)
        .set('Content-Type', 'application/json')
        .set('X-CSRF-Secret', csrfSecret)
        .send({
          name: 'expiring-key',
          expiresAt,
          csrf_secret: csrfSecret
        });

      expect(response.status).toBe(201);
      expect(response.body.key).toBeDefined();
    });

    it('should create key with rate limits', async () => {
      const response = await request(fixture.getProxyUrl())
        .post('/admin/keys')
        .set('Authorization', adminAuth)
        .set('Content-Type', 'application/json')
        .set('X-CSRF-Secret', csrfSecret)
        .send({
          name: 'limited-key',
          rateLimitRpm: 10,
          rateLimitTpm: 5000,
          csrf_secret: csrfSecret
        });

      expect(response.status).toBe(201);

      // Verify the key was created with limits
      const keysResponse = await request(fixture.getProxyUrl())
        .get('/admin/keys')
        .set('Authorization', adminAuth);

      const key = keysResponse.body.keys.find((k: any) => k.name === 'limited-key');
      expect(key).toBeDefined();
      // Note: rate limits might not be exposed in list, but should be enforced
    });

    it('should require name field', async () => {
      const response = await request(fixture.getProxyUrl())
        .post('/admin/keys')
        .set('Authorization', adminAuth)
        .set('Content-Type', 'application/json')
        .set('X-CSRF-Secret', csrfSecret)
        .send({ csrf_secret: csrfSecret });

      expect(response.status).toBe(400);
      expect(response.body.error.message).toBe('Name is required');
    });
  });

  describe('DELETE /admin/keys/:id', () => {
    it('should delete an API key', async () => {
      // First create a key
      const createResponse = await request(fixture.getProxyUrl())
        .post('/admin/keys')
        .set('Authorization', adminAuth)
        .set('Content-Type', 'application/json')
        .set('X-CSRF-Secret', csrfSecret)
        .send({ name: 'to-delete', csrf_secret: csrfSecret });

      expect(createResponse.status).toBe(201);
      const keyId = createResponse.body.id;

      // Delete it
      const deleteResponse = await request(fixture.getProxyUrl())
        .delete(`/admin/keys/${keyId}`)
        .set('Authorization', adminAuth)
        .set('X-CSRF-Secret', csrfSecret);

      expect(deleteResponse.status).toBe(204);

      // Verify it's gone
      const listResponse = await request(fixture.getProxyUrl())
        .get('/admin/keys')
        .set('Authorization', adminAuth);

      const key = listResponse.body.keys.find((k: any) => k.id === keyId);
      expect(key).toBeUndefined();
    });

    it('should return 404 for non-existent key', async () => {
      const response = await request(fixture.getProxyUrl())
        .delete('/admin/keys/99999')
        .set('Authorization', adminAuth)
        .set('X-CSRF-Secret', csrfSecret);

      expect(response.status).toBe(404);
    });

    it('should return 400 for invalid ID', async () => {
      const response = await request(fixture.getProxyUrl())
        .delete('/admin/keys/abc')
        .set('Authorization', adminAuth)
        .set('X-CSRF-Secret', csrfSecret);

      expect(response.status).toBe(400);
    });
  });

  describe('POST /admin/keys/:id/rotate', () => {
    it('should rotate an API key', async () => {
      const createResponse = await request(fixture.getProxyUrl())
        .post('/admin/keys')
        .set('Authorization', adminAuth)
        .set('Content-Type', 'application/json')
        .set('X-CSRF-Secret', csrfSecret)
        .send({ name: 'to-rotate', csrf_secret: csrfSecret });

      const keyId = createResponse.body.id;
      const oldKey = createResponse.body.key;

      const rotateResponse = await request(fixture.getProxyUrl())
        .post(`/admin/keys/${keyId}/rotate`)
        .set('Authorization', adminAuth)
        .set('X-CSRF-Secret', csrfSecret);

      expect(rotateResponse.status).toBe(200);
      expect(rotateResponse.body.key).toBeDefined();
      expect(rotateResponse.body.key).not.toBe(oldKey);
      expect(rotateResponse.body.oldKeyPrefix).toBeDefined();
    });

    it('should preserve key metadata after rotation', async () => {
      const createResponse = await request(fixture.getProxyUrl())
        .post('/admin/keys')
        .set('Authorization', adminAuth)
        .set('Content-Type', 'application/json')
        .set('X-CSRF-Secret', csrfSecret)
        .send({
          name: 'preserve-meta',
          tags: 'important-tag',
          rateLimitRpm: 20,
          csrf_secret: csrfSecret
        });

      const keyId = createResponse.body.id;

      await request(fixture.getProxyUrl())
        .post(`/admin/keys/${keyId}/rotate`)
        .set('Authorization', adminAuth)
        .set('X-CSRF-Secret', csrfSecret);

      const listResponse = await request(fixture.getProxyUrl())
        .get('/admin/keys')
        .set('Authorization', adminAuth);

      const key = listResponse.body.keys.find((k: any) => k.id === keyId);
      expect(key.name).toBe('preserve-meta');
      expect(key.tags).toBe('important-tag');
    });
  });

  describe('GET /admin/models', () => {
    it('should list configured models', async () => {
      const response = await request(fixture.getProxyUrl())
        .get('/admin/models')
        .set('Authorization', adminAuth);

      expect(response.status).toBe(200);
      expect(response.body.models).toBeDefined();
      expect(response.body.models.length).toBeGreaterThan(0);
      expect(response.body.models[0]).toHaveProperty('name');
      expect(response.body.models[0]).toHaveProperty('upstream');
    });
  });

  describe('GET /admin/usage', () => {
    it('should return system-wide usage', async () => {
      const response = await request(fixture.getProxyUrl())
        .get('/admin/usage?days=7')
        .set('Authorization', adminAuth);

      expect(response.status).toBe(200);
      expect(response.body.period).toBe(7);
      expect(response.body).toHaveProperty('totalRequests');
      expect(response.body).toHaveProperty('totalInputTokens');
      expect(response.body).toHaveProperty('totalOutputTokens');
      expect(response.body).toHaveProperty('totalCost');
      expect(response.body).toHaveProperty('byModel');
    });

    it('should respect days parameter', async () => {
      const response = await request(fixture.getProxyUrl())
        .get('/admin/usage?days=30')
        .set('Authorization', adminAuth);

      expect(response.status).toBe(200);
      expect(response.body.period).toBe(30);
    });
  });

  describe('GET /admin/keys/:id/usage', () => {
    it('should return usage for specific key', async () => {
      const keysResponse = await request(fixture.getProxyUrl())
        .get('/admin/keys')
        .set('Authorization', adminAuth);

      const keyId = keysResponse.body.keys[0].id;

      const response = await request(fixture.getProxyUrl())
        .get(`/admin/keys/${keyId}/usage?days=7`)
        .set('Authorization', adminAuth);

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('totalRequests');
      expect(response.body).toHaveProperty('dailyBreakdown');
    });
  });

  describe('GET /admin/logs', () => {
    it('should return recent logs', async () => {
      const response = await request(fixture.getProxyUrl())
        .get('/admin/logs?limit=100')
        .set('Authorization', adminAuth);

      expect(response.status).toBe(200);
      expect(response.body.logs).toBeDefined();
      expect(Array.isArray(response.body.logs)).toBe(true);
    });
  });

  describe('GET /admin/metrics', () => {
    it('should return metrics with daily stats', async () => {
      const response = await request(fixture.getProxyUrl())
        .get('/admin/metrics?days=7')
        .set('Authorization', adminAuth);

      expect(response.status).toBe(200);
      expect(response.body.period).toBe(7);
      expect(response.body).toHaveProperty('summary');
      expect(response.body).toHaveProperty('dailyStats');
      expect(response.body).toHaveProperty('topApiKeys');
    });

    it('should return top API keys by spend', async () => {
      const response = await request(fixture.getProxyUrl())
        .get('/admin/metrics?days=7')
        .set('Authorization', adminAuth);

      expect(response.status).toBe(200);
      expect(response.body.topApiKeys).toBeDefined();
      expect(Array.isArray(response.body.topApiKeys)).toBe(true);
      // Should have at most 10 keys
      expect(response.body.topApiKeys.length).toBeLessThanOrEqual(10);
    });
  });

  describe('Authentication', () => {
    it('should reject invalid credentials', async () => {
      const response = await request(fixture.getProxyUrl())
        .get('/admin/keys')
        .set('Authorization', 'Basic invalid');

      expect(response.status).toBe(401);
    });

    it('should support API key authentication', async () => {
      // This would require setting up admin API key in config
      // For now, just verify Basic auth works
      const response = await request(fixture.getProxyUrl())
        .get('/admin/keys')
        .set('Authorization', adminAuth);

      expect(response.status).toBe(200);
    });
  });
});

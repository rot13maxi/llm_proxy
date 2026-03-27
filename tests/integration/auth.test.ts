import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { apiKeyAuthMiddleware } from '../../src/middleware/auth.js';
import { ApiKeyQueries } from '../../src/db/queries.js';
import Database, { type Database as DatabaseType } from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';

describe('API Key Authentication', () => {
  let db: DatabaseType;
  let app: express.Express;
  let apiKeyQueries: ApiKeyQueries;
  let validApiKey: string;

  beforeEach(async () => {
    // Create in-memory database
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE api_keys (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        key_prefix TEXT NOT NULL,
        key_value TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        expires_at DATETIME,
        is_active BOOLEAN DEFAULT 1,
        rate_limit_rpm INTEGER DEFAULT 60,
        rate_limit_tpm INTEGER DEFAULT 100000
      );
      CREATE INDEX idx_api_keys_prefix ON api_keys(key_prefix);
    `);

    apiKeyQueries = new ApiKeyQueries(db);

    // Create a test API key (stored in plaintext - no hashing needed)
    const uuid = uuidv4();
    validApiKey = `sk-${uuid}`;
    const keyPrefix = uuid.slice(0, 8);
    db.prepare('INSERT INTO api_keys (key_prefix, key_value, name) VALUES (?, ?, ?)').run(keyPrefix, validApiKey, 'test-key');

    // Create Express app
    app = express();
    app.use(express.json());
    app.use(apiKeyAuthMiddleware(apiKeyQueries));
    
    app.get('/test', (req, res) => {
      res.json({ success: true, keyName: (req as any).apiKey?.name });
    });
  });

  afterEach(() => {
    db.close();
  });

  it('should reject requests without authorization header', async () => {
    const response = await request(app).get('/test');

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('missing_authorization');
  });

  it('should reject requests with invalid authorization header format', async () => {
    const response = await request(app)
      .get('/test')
      .set('Authorization', 'Invalid token');

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('missing_authorization');
  });

  it('should reject requests with invalid API key', async () => {
    const response = await request(app)
      .get('/test')
      .set('Authorization', 'Bearer invalid-key');

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('invalid_api_key');
  });

  it('should accept requests with valid API key', async () => {
    const response = await request(app)
      .get('/test')
      .set('Authorization', `Bearer ${validApiKey}`);

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.keyName).toBe('test-key');
  });

  it('should reject deactivated API keys', async () => {
    db.prepare('UPDATE api_keys SET is_active = 0 WHERE name = ?').run('test-key');

    const response = await request(app)
      .get('/test')
      .set('Authorization', `Bearer ${validApiKey}`);

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('invalid_api_key');
  });

  it('should reject expired API keys', async () => {
    db.prepare("UPDATE api_keys SET expires_at = datetime('now', '-1 day') WHERE name = ?").run('test-key');

    const response = await request(app)
      .get('/test')
      .set('Authorization', `Bearer ${validApiKey}`);

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('invalid_api_key');
  });
});

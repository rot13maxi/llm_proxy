import { type Request, type Response, type NextFunction } from 'express';
import { ApiKeyQueries } from '../db/queries.js';
import { timingSafeEqual } from '../utils/crypto.js';

/**
 * In-memory cache for validated API keys
 * Stores: keyPrefix -> { keyData: {...}, expiresAt: number }
 * TTL: 5 minutes to reduce DB lookups
 */
class ApiKeyCache {
  private cache = new Map<string, { keyData: any; expiresAt: number }>();
  private readonly TTL_MS = 5 * 60 * 1000; // 5 minutes

  get(keyPrefix: string): any | null {
    const entry = this.cache.get(keyPrefix);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(keyPrefix);
      return null;
    }
    return entry.keyData;
  }

  set(keyPrefix: string, keyData: any): void {
    this.cache.set(keyPrefix, {
      keyData,
      expiresAt: Date.now() + this.TTL_MS
    });
  }

  invalidate(keyPrefix: string): void {
    this.cache.delete(keyPrefix);
  }

  // Cleanup expired entries periodically
  cleanup(): void {
    const now = Date.now();
    for (const [key, entry] of this.cache) {
      if (now > entry.expiresAt) {
        this.cache.delete(key);
      }
    }
  }
}

const apiKeyCache = new ApiKeyCache();

/**
 * API Key Authentication Middleware (with caching)
 * 
 * Flow:
 * ┌─────────────┐    ┌─────────────┐    ┌─────────────┐
 * │  Request    │───▶│  Check Cache│───▶│  Validate   │
 * │  (Bearer)   │    │  (5 min TTL)│    │  in DB      │
 * └─────────────┘    └─────────────┘    └─────────────┘
 * 
 * API keys are random UUIDs stored in plaintext - no slow hashing needed.
 * Cache makes repeated requests ~0ms overhead.
 */
export function apiKeyAuthMiddleware(apiKeyQueries: ApiKeyQueries) {
  return (req: Request, res: Response, next: NextFunction) => {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        error: {
          message: 'Missing or invalid authorization header',
          code: 'missing_authorization'
        }
      });
    }

    const key = authHeader.substring(7);
    const keyPrefix = key.slice(3, 11);

    // Check cache first
    const cached = apiKeyCache.get(keyPrefix);
    if (cached) {
      (req as Request & { apiKey: typeof cached }).apiKey = cached;
      return next();
    }

    // Not in cache - validate from DB (fast path, ~0ms with plaintext comparison)
    const validated = apiKeyQueries.validateKey(key);

    if (!validated) {
      return res.status(401).json({
        error: {
          message: 'Invalid API key',
          code: 'invalid_api_key'
        }
      });
    }

    // Cache successful validation
    apiKeyCache.set(keyPrefix, validated);

    // Attach to request for downstream use
    (req as Request & { apiKey: typeof validated }).apiKey = validated;
    next();
  };
}

/**
 * Admin Authentication Middleware
 * Supports both Basic Auth and API Key
 * 
 * Flow:
 * ┌─────────────┐    ┌─────────────┐    ┌─────────────┐
 * │  Request    │───▶│  Check      │───▶│  Check      │
 * │             │    │  Basic Auth │    │  API Key    │
 * └─────────────┘    └─────────────┘    └─────────────┘
 */
export function adminAuthMiddleware(config: {
  username?: string;
  password?: string;
  api_key?: string;
}) {
  return (req: Request, res: Response, next: NextFunction) => {
    // Check API key first (X-Admin-Key header)
    const adminKey = Array.isArray(req.headers['x-admin-key'])
      ? req.headers['x-admin-key'][0]
      : req.headers['x-admin-key'];
    if (timingSafeEqual(adminKey, config.api_key)) {
      return next();
    }

    // Check Basic Auth
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Basic ')) {
      const base64Credentials = authHeader.substring(6);
      const credentials = Buffer.from(base64Credentials, 'base64').toString('utf-8');
      const [username, password] = credentials.split(':', 2);

      if (timingSafeEqual(username, config.username) && timingSafeEqual(password, config.password)) {
        return next();
      }
    }

    return res.status(401).json({
      error: {
        message: 'Unauthorized',
        code: 'unauthorized'
      }
    });
  };
}

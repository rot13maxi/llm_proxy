import { type Request, type Response, type NextFunction } from 'express';
import { ApiKeyQueries } from '../db/queries.js';
import crypto from 'crypto';

function timingSafeEqual(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * API Key Authentication Middleware
 * 
 * Flow:
 * ┌─────────────┐    ┌─────────────┐    ┌─────────────┐
 * │  Request    │───▶│  Extract    │───▶│  Validate   │
 * │  (Bearer)   │    │  Header     │    │  in DB      │
 * └─────────────┘    └─────────────┘    └─────────────┘
 */
export function apiKeyAuthMiddleware(apiKeyQueries: ApiKeyQueries) {
  return async (req: Request, res: Response, next: NextFunction) => {
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
    const validated = await apiKeyQueries.validateKey(key);

    if (!validated) {
      return res.status(401).json({
        error: {
          message: 'Invalid API key',
          code: 'invalid_api_key'
        }
      });
    }

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

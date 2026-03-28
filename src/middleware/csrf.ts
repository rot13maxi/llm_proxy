import { type Request, type Response, type NextFunction } from 'express';
import crypto from 'crypto';

const CSRF_SECRET_LENGTH = 32;

export function csrfProtection() {
  return (req: Request, res: Response, next: NextFunction) => {
    const csrfToken = req.cookies.csrf_token;
    const csrfSecret = req.body?.csrf_secret || req.headers['x-csrf-secret'] as string;

    // Skip CSRF validation for GET requests and if already authenticated via API key or Basic Auth
    if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method)) {
      // If using API key auth (X-Admin-Key header) or Basic Auth, skip CSRF
      if (req.headers['x-admin-key'] || (req.headers.authorization && req.headers.authorization.startsWith('Basic '))) {
        return next();
      }
      
      if (!csrfSecret) {
        return res.status(403).json({
          error: {
            message: 'CSRF validation failed: missing secret',
            code: 'csrf_missing_secret'
          }
        });
      }

      if (!csrfToken || !crypto.timingSafeEqual(
        Buffer.from(csrfSecret),
        Buffer.from(csrfToken)
      )) {
        return res.status(403).json({
          error: {
            message: 'CSRF validation failed: invalid token',
            code: 'csrf_invalid_token'
          }
        });
      }
    }

    if (!csrfToken) {
      const secret = crypto.randomBytes(CSRF_SECRET_LENGTH).toString('hex');
      res.cookie('csrf_token', secret, {
        httpOnly: false,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: 24 * 60 * 60 * 1000
      });
      res.locals.csrfSecret = secret;
    }

    next();
  };
}

export function getCsrfSecret() {
  return (req: Request, res: Response, next: NextFunction) => {
    // Generate a secret if one doesn't exist
    if (!res.locals.csrfSecret && !req.cookies.csrf_token) {
      const secret = crypto.randomBytes(CSRF_SECRET_LENGTH).toString('hex');
      res.cookie('csrf_token', secret, {
        httpOnly: false,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: 24 * 60 * 60 * 1000
      });
      res.locals.csrfSecret = secret;
    }
    
    res.json({ csrf_secret: res.locals.csrfSecret || req.cookies.csrf_token });
    next();
  };
}
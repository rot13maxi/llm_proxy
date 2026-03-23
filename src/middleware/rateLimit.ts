import { type Request, type Response, type NextFunction } from 'express';

/**
 * In-memory rate limiter with sliding window
 * 
 * Data Structure:
 * ┌─────────────────────────────────────────────────────┐
 * │  Map<apiKeyId, {                                    │
 * │    requests: Map<minute, count>,                   │
 * │    tokens: Map<minute, count>                      │
 * │  }>                                                │
 * └─────────────────────────────────────────────────────┘
 * 
 * Cleanup runs every minute to remove old entries
 */
interface RateLimitWindow {
  requests: Map<number, number>; // minute timestamp -> count
  tokens: Map<number, number>;
}

export class RateLimiter {
  private windows: Map<number, RateLimitWindow> = new Map();
  private cleanupInterval: NodeJS.Timeout | null = null;

  constructor() {
    this.startCleanup();
  }

  private startCleanup(): void {
    // Clean up old windows every minute
    this.cleanupInterval = setInterval(() => {
      const oneMinuteAgo = Math.floor(Date.now() / 60000) - 1;
      
      for (const [keyId, window] of this.windows.entries()) {
        // Remove old entries
        for (const [minute] of window.requests) {
          if (minute < oneMinuteAgo) {
            window.requests.delete(minute);
          }
        }
        for (const [minute] of window.tokens) {
          if (minute < oneMinuteAgo) {
            window.tokens.delete(minute);
          }
        }

        // Remove empty windows
        if (window.requests.size === 0 && window.tokens.size === 0) {
          this.windows.delete(keyId);
        }
      }
    }, 60000);
  }

  /**
   * Atomically check and record a request
   * Returns { allowed: boolean, retryAfter?: number }
   * This method is atomic - check and record happen together to prevent race conditions
   */
  checkAndRecord(
    apiKeyId: number,
    inputTokens: number,
    limits: { rpm: number; tpm: number }
  ): { allowed: boolean; retryAfter?: number } {
    const currentMinute = Math.floor(Date.now() / 60000);
    
    // Get or create window for this API key
    if (!this.windows.has(apiKeyId)) {
      this.windows.set(apiKeyId, {
        requests: new Map(),
        tokens: new Map()
      });
    }

    const window = this.windows.get(apiKeyId)!;

    // Get current minute counts
    const currentRequests = window.requests.get(currentMinute) || 0;
    const currentTokens = window.tokens.get(currentMinute) || 0;

    // Check rate limits
    if (currentRequests >= limits.rpm) {
      return { allowed: false, retryAfter: 60 };
    }

    if (currentTokens + inputTokens > limits.tpm) {
      return { allowed: false, retryAfter: 60 };
    }

    // Record the request atomically after successful check
    window.requests.set(currentMinute, currentRequests + 1);
    window.tokens.set(currentMinute, currentTokens + inputTokens);

    return { allowed: true };
  }

  /**
   * Get current usage for an API key
   */
  getCurrentUsage(apiKeyId: number): { requests: number; tokens: number } {
    const currentMinute = Math.floor(Date.now() / 60000);
    const window = this.windows.get(apiKeyId);

    if (!window) {
      return { requests: 0, tokens: 0 };
    }

    return {
      requests: window.requests.get(currentMinute) || 0,
      tokens: window.tokens.get(currentMinute) || 0
    };
  }

  cleanup(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
    this.windows.clear();
  }
}

/**
 * Express middleware for rate limiting
 */
export function rateLimitMiddleware(
  rateLimiter: RateLimiter,
  defaultLimits: { rpm: number; tpm: number }
) {
  return (req: Request & { apiKey?: { id: number; rateLimitRpm: number; rateLimitTpm: number } }, res: Response, next: NextFunction) => {
    const apiKey = req.apiKey;
    
    if (!apiKey) {
      return next(); // Already handled by auth middleware
    }

    // Use key-specific limits or defaults
    const limits = {
      rpm: apiKey.rateLimitRpm || defaultLimits.rpm,
      tpm: apiKey.rateLimitTpm || defaultLimits.tpm
    };

    // Estimate input tokens from request body for pre-check
    // This is a rough estimate; actual tokens counted after response
    const body = req.body;
    let estimatedInputTokens = 0;
    
    if (body && body.messages) {
      // Rough estimate: 4 chars ≈ 1 token
      const totalChars = body.messages
        .map((m: { content?: string }) => m.content || '')
        .join('')
        .length;
      estimatedInputTokens = Math.ceil(totalChars / 4);
    }

    const result = rateLimiter.checkAndRecord(apiKey.id, estimatedInputTokens, limits);

    if (!result.allowed) {
      return res.status(429).json({
        error: {
          message: 'Rate limit exceeded',
          code: 'rate_limit_exceeded',
          retry_after: result.retryAfter
        },
        limit: limits,
        current: rateLimiter.getCurrentUsage(apiKey.id)
      });
    }

    next();
  };
}

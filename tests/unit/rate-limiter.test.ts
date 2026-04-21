import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { RateLimiter } from '../../src/middleware/rateLimit.js';

describe('RateLimiter', () => {
  let rateLimiter: RateLimiter;

  beforeEach(() => {
    rateLimiter = new RateLimiter();
  });

  afterEach(() => {
    rateLimiter.cleanup();
  });

  describe('checkAndRecord', () => {
    it('should allow request under limits', () => {
      const result = rateLimiter.checkAndRecord(1, 100, { rpm: 100, tpm: 10000 });
      
      expect(result.allowed).toBe(true);
      expect(result.retryAfter).toBeUndefined();
    });

    it('should reject when RPM exceeded', () => {
      // Make 10 requests to hit limit
      for (let i = 0; i < 10; i++) {
        rateLimiter.checkAndRecord(1, 1, { rpm: 10, tpm: 10000 });
      }
      
      const result = rateLimiter.checkAndRecord(1, 1, { rpm: 10, tpm: 10000 });
      
      expect(result.allowed).toBe(false);
      expect(result.retryAfter).toBe(60);
    });

    it('should reject when TPM exceeded', () => {
      // Make requests totaling 950 tokens (under 1000 limit)
      rateLimiter.checkAndRecord(1, 500, { rpm: 100, tpm: 1000 });
      rateLimiter.checkAndRecord(1, 450, { rpm: 100, tpm: 1000 });
      
      // This should exceed TPM (500 + 450 + 50 = 1000)
      const result = rateLimiter.checkAndRecord(1, 50, { rpm: 100, tpm: 1000 });
      
      expect(result.allowed).toBe(false);
      expect(result.retryAfter).toBe(60);
    });

    it('should track per-key separately', () => {
      // Key 1 at limit
      for (let i = 0; i < 10; i++) {
        rateLimiter.checkAndRecord(1, 1, { rpm: 10, tpm: 10000 });
      }
      
      // Key 2 should still be allowed
      const result = rateLimiter.checkAndRecord(2, 1, { rpm: 10, tpm: 10000 });
      
      expect(result.allowed).toBe(true);
    });

    it('should accumulate tokens across requests', () => {
      rateLimiter.checkAndRecord(1, 400, { rpm: 100, tpm: 1000 });
      rateLimiter.checkAndRecord(1, 400, { rpm: 100, tpm: 1000 });
      
      // This should be allowed (400 + 400 + 100 = 900 < 1000)
      const result1 = rateLimiter.checkAndRecord(1, 100, { rpm: 100, tpm: 1000 });
      expect(result1.allowed).toBe(true);
      
      // This should exceed TPM (400 + 400 + 100 + 100 = 1000)
      const result2 = rateLimiter.checkAndRecord(1, 100, { rpm: 100, tpm: 1000 });
      expect(result2.allowed).toBe(false);
    });
  });

  describe('getCurrentUsage', () => {
    it('should return zero for new key', () => {
      const usage = rateLimiter.getCurrentUsage(999);
      
      expect(usage.requests).toBe(0);
      expect(usage.tokens).toBe(0);
    });

    it('should return current minute usage', () => {
      rateLimiter.checkAndRecord(1, 100, { rpm: 100, tpm: 10000 });
      rateLimiter.checkAndRecord(1, 200, { rpm: 100, tpm: 10000 });
      
      const usage = rateLimiter.getCurrentUsage(1);
      
      expect(usage.requests).toBe(2);
      expect(usage.tokens).toBe(300);
    });
  });

  describe('cleanup', () => {
    it('should clear all rate limit data', () => {
      rateLimiter.checkAndRecord(1, 100, { rpm: 100, tpm: 10000 });
      
      rateLimiter.cleanup();
      
      const usage = rateLimiter.getCurrentUsage(1);
      expect(usage.requests).toBe(0);
      expect(usage.tokens).toBe(0);
    });
  });
});

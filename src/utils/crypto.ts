import crypto from 'crypto';

/**
 * Timing-safe string comparison to prevent timing attacks
 * 
 * Used for comparing API keys and admin credentials
 */
export function timingSafeEqual(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

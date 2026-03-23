# Rate Limiting

## Overview

The LLM Proxy enforces per-key rate limits on both requests per minute (RPM) and tokens per minute (TPM).

## Architecture

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  API Request    │────▶│  Auth Middleware│────▶│ Rate Limit      │
│                 │     │  (validate key) │     │ Middleware      │
└─────────────────┘     └─────────────────┘     └─────────────────┘
                                              │
                                              ▼
                                      ┌─────────────────┐
                                      │  RateLimiter    │
                                      │  (in-memory)    │
                                      │  Map<keyId,     │
                                      │   RateWindow>   │
                                      └─────────────────┘
```

## Data Structure

The `RateLimiter` class maintains an in-memory map:

```typescript
interface RateLimitWindow {
  requests: Map<number, number>; // minute timestamp -> count
  tokens: Map<number, number>;
}

// Global state
windows: Map<apiKeyId, RateLimitWindow>
```

Each API key gets its own window tracking:
- Request count per minute
- Token count per minute

## Flow

1. **Request arrives** with API key in Authorization header
2. **Auth middleware** validates key and attaches to request:
   ```typescript
   req.apiKey = { id, name, rateLimitRpm, rateLimitTpm }
   ```
3. **Rate limit middleware** checks limits:
   - Uses key-specific limits if configured
   - Falls back to default limits if not set
   - Estimates input tokens from request body (4 chars ≈ 1 token)
4. **RateLimiter.checkAndRecord()** atomically:
   - Gets/creates window for this key
   - Checks current minute counts against limits
   - If under limit: records request and returns allowed
   - If over limit: returns denied with retryAfter
5. **Response**:
   - 200: Request proceeds to upstream
   - 429: Rate limit exceeded with `retry_after` field

## Configuration

### Default Limits
```yaml
rate_limits:
  default:
    requests_per_minute: 60
    tokens_per_minute: 100000
```

### Per-Key Limits
When creating an API key, you can specify custom limits:
```typescript
const { id, key } = await apiKeyQueries.createKey(
  'my-key',
  expiresAt,
  rateLimitRpm: 100,    // Custom RPM
  rateLimitTpm: 200000  // Custom TPM
);
```

## Cleanup

The rate limiter runs a cleanup interval every 60 seconds that:
- Removes request/token entries older than 1 minute
- Removes empty windows (keys with no recent activity)

This prevents memory leaks from long-running servers.

## Known Limitations

1. **Token estimation**: Rate limiting uses estimated input tokens (4 chars ≈ 1 token), not actual tokens. Actual tokens are logged after the response but not used for rate limiting.

2. **In-memory only**: Rate limit state is not persisted. Server restart resets all counters.

3. **Single server**: Rate limits are not shared across multiple proxy instances. For multi-instance deployments, consider Redis or similar.

## Testing

Integration tests in `tests/integration/rate-limit.test.ts`:
- Validates per-key rate limiting
- Tests custom per-key limits
- Verifies 429 response with retry_after

Run tests:
```bash
npm run test:integration -- rate-limit.test.ts
```

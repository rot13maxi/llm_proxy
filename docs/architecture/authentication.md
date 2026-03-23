# Authentication

## Overview

The LLM Proxy uses two authentication mechanisms:
1. **API Key Authentication** - For client requests to `/v1/*` endpoints
2. **Admin Authentication** - For administrative tasks on `/admin/*` endpoints

## API Key Authentication

### Key Format

API keys follow the format: `sk-{uuid}`

Example: `sk-96acfe3e-5890-4f9b-8ae2-06ecc6fefd6b`

### Security Model

```
┌─────────────────────────────────────────────────────────┐
│  API Key Lifecycle                                      │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  1. Creation                                            │
│     └─ Generate UUID, create full key (sk-{uuid})      │
│     └─ Hash key with Argon2 (memoryCost: 65536)        │
│     └─ Store: key_prefix (first 8 chars), key_hash     │
│                                                         │
│  2. Validation                                          │
│     └─ Extract key from Authorization header           │
│     └─ Extract key_prefix (chars 3-11)                 │
│     └─ Look up by key_prefix (fast index lookup)       │
│     └─ Verify full key against hash (Argon2)           │
│     └─ Check: is_active, expires_at                    │
│                                                         │
│  3. Usage                                               │
│     └─ Attach validated key info to request            │
│     └─ { id, name, rateLimitRpm, rateLimitTpm }        │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

### Why Key Prefix?

Instead of hashing all keys on every request, we:
1. Store only the first 8 characters of the UUID as `key_prefix`
2. Index `key_prefix` for fast lookup
3. Only hash-verify the single matching key

This reduces Argon2 operations from N (all keys) to 1 (matching prefix).

### Authentication Flow

```typescript
// 1. Client sends request
Authorization: Bearer sk-96acfe3e-5890-4f9b-8ae2-06ecc6fefd6b

// 2. Middleware extracts and validates
const key = authHeader.substring(7); // Remove "Bearer "
const keyPrefix = key.slice(3, 11);  // Get "96acfe3e"

// 3. Database lookup
const row = db.prepare(`
  SELECT id, name, key_hash, rate_limit_rpm, rate_limit_tpm
  FROM api_keys
  WHERE key_prefix = ?
    AND is_active = 1
    AND (expires_at IS NULL OR expires_at > datetime('now'))
`).get(keyPrefix);

// 4. Hash verification
const isValid = await verify(row.key_hash, key, {
  memoryCost: 65536,
  timeCost: 2,
  parallelism: 1
});

// 5. Attach to request
req.apiKey = {
  id: row.id,
  name: row.name,
  rateLimitRpm: row.rate_limit_rpm,
  rateLimitTpm: row.rate_limit_tpm
};
```

### Creating API Keys

Via Admin API:
```bash
curl -X POST http://localhost:4000/admin/keys \
  -u admin:password \
  -H "Content-Type: application/json" \
  -d '{
    "name": "my-app",
    "rateLimitRpm": 100,
    "rateLimitTpm": 200000
  }'

# Response:
{
  "id": 1,
  "key": "sk-96acfe3e-5890-4f9b-8ae2-06ecc6fefd6b",
  "name": "my-app",
  "created_at": "2026-03-23T..."
}
```

⚠️ **Important**: The full key is only returned once during creation. Store it securely!

## Admin Authentication

### Methods

The proxy supports two admin authentication methods:

#### 1. Basic Auth
```yaml
# config.yaml
admin:
  username: admin
  password: your_secure_password
```

Usage:
```bash
curl -u admin:your_secure_password http://localhost:4000/admin/keys
```

#### 2. API Key
```yaml
# config.yaml
admin:
  api_key: your_master_admin_key
```

Usage:
```bash
curl -H "X-Admin-Key: your_master_admin_key" http://localhost:4000/admin/keys
```

### Security Considerations

- **Timing-Safe Comparison**: Uses `crypto.timingSafeEqual()` to prevent timing attacks
- **No Key Storage**: Admin credentials are only in config file, never in database
- **Config File Security**: Ensure `config.yaml` has proper file permissions (600)

## Error Responses

### Invalid API Key
```json
{
  "error": {
    "message": "Invalid API key",
    "code": "invalid_api_key"
  }
}
```

### Missing Authorization
```json
{
  "error": {
    "message": "Missing or invalid authorization header",
    "code": "missing_authorization"
  }
}
```

### Admin Unauthorized
```json
{
  "error": {
    "message": "Unauthorized",
    "code": "unauthorized"
  }
}
```

## Best Practices

1. **Rotate Keys Regularly**: Set `expires_at` when creating keys
2. **Use Descriptive Names**: Make it easy to identify key usage
3. **Set Appropriate Rate Limits**: Prevent abuse and control costs
4. **Secure Config File**: `chmod 600 config.yaml`
5. **Monitor Usage**: Check `/admin/usage` regularly
6. **Revoke Compromised Keys**: Use DELETE `/admin/keys/:id`

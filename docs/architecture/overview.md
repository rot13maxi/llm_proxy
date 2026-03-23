# Architecture Overview

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        LLM Proxy Gateway                        │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │                    Express Server                        │   │
│  │  ┌─────────────────────────────────────────────────┐    │   │
│  │  │              Middleware Stack                   │    │   │
│  │  │  1. Request Logger                              │    │   │
│  │  │  2. API Key Auth (for /v1/*)                   │    │   │
│  │  │  3. Rate Limiter                                │    │   │
│  │  │  4. Admin Auth (for /admin/*)                  │    │   │
│  │  └─────────────────────────────────────────────────┘    │   │
│  │  ┌─────────────────────────────────────────────────┐    │   │
│  │  │                   Routes                       │    │   │
│  │  │  • /v1/chat/completions (OpenAI)              │    │   │
│  │  │  • /v1/messages (Anthropic)                   │    │   │
│  │  │  • /admin/* (Dashboard)                       │    │   │
│  │  └─────────────────────────────────────────────────┘    │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │                    Services                             │   │
│  │  • ProxyService    - Forward requests to upstream      │   │
│  │  • MeteringService - Calculate costs, log usage        │   │
│  │  • MetricsService  - Prometheus metrics                │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │                   Database (SQLite)                     │   │
│  │  • api_keys       - API key storage                    │   │
│  │  • usage_logs     - Request history                    │   │
│  │  • model_config   - Model upstream mappings            │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────────┐
│                      Upstream LLM Servers                       │
│  • sglang, vllm, or any OpenAI-compatible server               │
└─────────────────────────────────────────────────────────────────┘
```

## Request Flow

### OpenAI-Compatible Request

```
1. Client → Proxy
   POST /v1/chat/completions
   Authorization: Bearer sk-xxx
   
2. Middleware Processing
   ├─ Request Logger (log incoming request)
   ├─ API Key Auth (validate key, attach to req)
   ├─ Rate Limiter (check limits, reject if exceeded)
   └─ (passes to route handler)
   
3. Route Handler (/v1/chat/completions)
   ├─ Validate request body
   ├─ Call ProxyService.proxyOpenAI()
   │   ├─ Get model config from DB
   │   ├─ Forward to upstream server
   │   └─ Return response + usage
   ├─ Log usage via MeteringService
   └─ Record metrics via MetricsService
   
4. Response → Client
   { choices: [...], usage: {...} }
```

### Anthropic-Compatible Request

```
1. Client → Proxy
   POST /v1/messages
   Authorization: Bearer sk-xxx
   
2. Middleware Processing (same as OpenAI)
   
3. Route Handler (/v1/messages)
   ├─ Validate request body
   ├─ Call ProxyService.proxyAnthropic()
   │   ├─ Transform Anthropic → OpenAI
   │   ├─ Forward to upstream (OpenAI format)
   │   ├─ Transform response OpenAI → Anthropic
   │   └─ Return response + usage
   ├─ Log usage via MeteringService
   └─ Record metrics via MetricsService
   
4. Response → Client
   { type: "message", content: [...], usage: {...} }
```

## Components

### Server (`src/server.ts`)
- Express application setup
- Middleware chain configuration
- Service initialization
- Graceful shutdown handling

### Configuration (`src/config/`)
- YAML config file parsing
- Zod schema validation
- Environment variable support

### Database (`src/db/`)
- SQLite with better-sqlite3
- Migration management
- Query classes (ApiKeyQueries, UsageLogQueries, ModelConfigQueries)

### Middleware
- **Auth**: API key validation with Argon2 hashing
- **Rate Limit**: Per-key sliding window rate limiting
- **Logger**: Request/response logging with timing

### Services
- **Proxy**: HTTP forwarding to upstream servers
- **Metering**: Cost calculation and usage logging
- **Metrics**: Prometheus metrics collection

### Routes
- **OpenAI**: `/v1/chat/completions`
- **Anthropic**: `/v1/messages`
- **Admin**: `/admin/*` (dashboard, keys, usage)

## Data Models

### API Keys
```sql
CREATE TABLE api_keys (
  id INTEGER PRIMARY KEY,
  key_prefix TEXT,      -- First 8 chars of UUID
  key_hash TEXT,        -- Argon2 hash of full key
  name TEXT,
  created_at DATETIME,
  expires_at DATETIME,
  is_active BOOLEAN,
  rate_limit_rpm INTEGER,
  rate_limit_tpm INTEGER
);
```

### Usage Logs
```sql
CREATE TABLE usage_logs (
  id INTEGER PRIMARY KEY,
  api_key_id INTEGER,
  model TEXT,
  request_timestamp DATETIME,
  input_tokens INTEGER,
  output_tokens INTEGER,
  latency_ms INTEGER,
  status_code INTEGER,
  cost_usd REAL
);
```

### Model Config
```sql
CREATE TABLE model_config (
  name TEXT PRIMARY KEY,
  upstream_url TEXT,
  cost_per_1k_input REAL,
  cost_per_1k_output REAL
);
```

## Technology Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Node.js 20+ |
| Framework | Express.js |
| Database | SQLite (better-sqlite3) |
| Config | YAML (js-yaml) |
| Validation | Zod |
| Auth | Argon2 |
| Metrics | prom-client |
| Testing | Vitest, Supertest |
| Type Safety | TypeScript |

## Deployment

### Docker
```bash
docker-compose up -d
```

### Standalone
```bash
npm install
cp config.example.yaml config.yaml
# Edit config.yaml
npm run build
npm start
```

## Next Steps

See individual component documentation:
- [Rate Limiting](rate-limiting.md)
- [Authentication](authentication.md)
- [API Reference](../api/reference.md)

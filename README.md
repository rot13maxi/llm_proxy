# LLM Proxy

A lightweight, self-hosted LLM proxy/gateway that provides OpenAI and Anthropic-compatible APIs in front of your local inference servers (sglang, vllm, etc.).

**No enterprise upsells. No bloat. Just what you need.**

## Features

- ✅ **OpenAI-compatible endpoint** (`/v1/chat/completions`) with streaming
- ✅ **Anthropic-compatible endpoint** (`/v1/messages`)
- ✅ **API key management** - create, list, delete, expire
- ✅ **Rate limiting** - per-key, configurable (RPM/TPM)
- ✅ **Usage tracking** - SQLite, 90-day retention (configurable)
- ✅ **Cost metering** - configurable per-model costs
- ✅ **Admin API** - REST endpoints for dashboard
- ✅ **Prometheus metrics** - `/metrics` endpoint
- ✅ **Zero external dependencies** - SQLite only, single container

## Quick Start

### 1. Install & Configure

```bash
cd llm_proxy
npm install
cp config.example.yaml config.yaml
# Edit config.yaml (change admin password!)
```

### 2. Run

```bash
# Development (hot reload)
npm run dev

# Or production
npm run build && npm start

# Or Docker
docker-compose up -d
```

### 3. Create API Key

```bash
curl -X POST http://localhost:4000/admin/keys \
  -u admin:your_password \
  -H "Content-Type: application/json" \
  -d '{"name": "my-app"}'
```

Save the `key` from the response!

### 4. Test

```bash
curl -X POST http://localhost:4000/v1/chat/completions \
  -H "Authorization: Bearer sk-xxx-xxx-xxx" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "qwen-2.5-7b",
    "messages": [{"role": "user", "content": "Hello"}]
  }'
```

## Configuration

```yaml
# config.yaml

server:
  port: 4000
  host: 0.0.0.0

database:
  path: ./data/llm_proxy.db
  retention_days: 90

admin:
  # Option 1: Basic Auth
  username: admin
  password: change_me_to_secure_password
  
  # Option 2: API Key (use X-Admin-Key header)
  # api_key: your_master_admin_key

models:
  - name: qwen-2.5-7b
    upstream: http://localhost:3000/v1/chat/completions
    cost_per_1k_input: 0.001
    cost_per_1k_output: 0.002
    
  - name: qwen-2.5-32b
    upstream: http://localhost:3001/v1/chat/completions
    cost_per_1k_input: 0.002
    cost_per_1k_output: 0.004

rate_limits:
  default:
    requests_per_minute: 60
    tokens_per_minute: 100000
```

## API Reference

### OpenAI-Compatible Endpoints

#### POST `/v1/chat/completions`

**Headers:**
- `Authorization: Bearer <api_key>`
- `Content-Type: application/json`

**Request:**
```json
{
  "model": "qwen-2.5-7b",
  "messages": [
    {"role": "user", "content": "Hello"}
  ],
  "stream": false,
  "temperature": 0.7
}
```

**Response:**
```json
{
  "id": "chat-xxx",
  "choices": [{
    "message": {"role": "assistant", "content": "Hi there!"},
    "finish_reason": "stop"
  }],
  "usage": {
    "prompt_tokens": 10,
    "completion_tokens": 8,
    "total_tokens": 18
  }
}
```

**Streaming** (set `stream: true`):
```
data: {"id":"chat-xxx","choices":[{"delta":{"content":"Hi"}}]}

data: {"id":"chat-xxx","choices":[{"delta":{"content":" there"}}]}

data: {"id":"chat-xxx","choices":[{"finish_reason":"stop"}]}
```

### Anthropic-Compatible Endpoints

#### POST `/v1/messages`

**Headers:**
- `Authorization: Bearer <api_key>`
- `anthropic-version: 2023-06-01`
- `Content-Type: application/json`

**Request:**
```json
{
  "model": "qwen-2.5-7b",
  "messages": [
    {"role": "user", "content": "Hello"}
  ],
  "max_tokens": 100
}
```

**Response:**
```json
{
  "id": "msg-xxx",
  "type": "message",
  "role": "assistant",
  "content": [{"type": "text", "text": "Hi there!"}],
  "usage": {
    "input_tokens": 10,
    "output_tokens": 8
  }
}
```

### Admin Endpoints

All admin endpoints require authentication via:
- Basic Auth: `-u username:password`
- API Key: `-H "X-Admin-Key: <admin_api_key>"`

#### GET `/admin/keys`
List all API keys with usage stats.

#### POST `/admin/keys`
Create a new API key.
```json
{
  "name": "production-key",
  "expiresAt": "2025-12-31",
  "rateLimitRpm": 100,
  "rateLimitTpm": 200000
}
```

#### DELETE `/admin/keys/:id`
Revoke an API key.

#### GET `/admin/usage?days=7`
Get system-wide usage statistics.

#### GET `/admin/keys/:id/usage?days=7`
Get usage for a specific API key.

#### GET `/admin/logs?limit=100`
Get recent request logs.

#### GET `/admin/models`
List configured models.

#### GET `/admin/health`
Health check endpoint.

#### GET `/metrics`
Prometheus metrics (no auth required).

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         Client Layer                             │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐          │
│  │  OpenAI App  │  │Anthropic App │  │  Dashboard   │          │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘          │
└─────────┼─────────────────┼─────────────────┼──────────────────┘
          │                 │                 │
          └─────────────────┴─────────────────┘
                              │
┌─────────────────────────────┼───────────────────────────────────┐
│                      Express Server                             │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │  Middleware Stack                                        │   │
│  │  1. requestLogger (logs all requests)                   │   │
│  │  2. apiKeyAuth (validates Bearer token)                 │   │
│  │  3. rateLimit (per-key sliding window)                  │   │
│  │  4. adminAuth (Basic Auth or API key)                   │   │
│  └─────────────────────────────────────────────────────────┘   │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │  Routes                                                  │   │
│  │  • /v1/chat/completions → OpenAI proxy                 │   │
│  │  • /v1/messages → Anthropic proxy                      │   │
│  │  • /admin/* → Dashboard API                             │   │
│  │  • /metrics → Prometheus metrics                        │   │
│  └─────────────────────────────────────────────────────────┘   │
└─────────────────────────────┼───────────────────────────────────┘
                              │
┌─────────────────────────────┼───────────────────────────────────┐
│                      Data Layer                                 │
│  ┌──────────────────┐    ┌──────────────────┐                  │
│  │  SQLite DB       │    │  Prometheus      │                  │
│  │  • api_keys      │    │  • request_count │                  │
│  │  • usage_logs    │    │  • token_count   │                  │
│  │  • model_config  │    │  • latency_p99   │                  │
│  └──────────────────┘    └──────────────────┘                  │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                      Upstream Layer                             │
│  ┌───────────────────┐    ┌───────────────────┐                │
│  │  sglang :3000     │    │  sglang :3001     │                │
│  │  (qwen-2.5-7b)    │    │  (qwen-2.5-32b)   │                │
│  └───────────────────┘    └───────────────────┘                │
└─────────────────────────────────────────────────────────────────┘
```

## Request Flow

```
Client Request
     │
     ▼
┌─────────────────────────────────────────────────────────────┐
│ 1. Auth Middleware                                          │
│    ┌─────────────────────────────────────────────────────┐ │
│    │ • Extract Bearer token from Authorization header    │ │
│    │ • Hash with Argon2 and verify against DB            │ │
│    │ • Return 401 if invalid/expired                     │ │
│    └─────────────────────────────────────────────────────┘ │ │
└─────────────────────────────────────────────────────────────┘
     │
     ▼
┌─────────────────────────────────────────────────────────────┐
│ 2. Rate Limit Middleware                                    │
│    ┌─────────────────────────────────────────────────────┐ │
│    │ • Check requests/minute for this API key            │ │
│    │ • Check tokens/minute for this API key              │ │
│    │ • Return 429 if exceeded                            │ │
│    └─────────────────────────────────────────────────────┘ │ │
└─────────────────────────────────────────────────────────────┘
     │
     ▼
┌─────────────────────────────────────────────────────────────┐
│ 3. Route Handler                                            │
│    ┌─────────────────────────────────────────────────────┐ │
│    │ • Resolve model name → upstream URL                 │ │
│    │ • Transform request format (Anthropic→OpenAI)       │ │
│    │ • Forward to upstream (sglang/vllm)                 │ │
│    │ • Stream response back (SSE passthrough)            │ │
│    └─────────────────────────────────────────────────────┘ │ │
└─────────────────────────────────────────────────────────────┘
     │
     ▼
┌─────────────────────────────────────────────────────────────┐
│ 4. Metering Service                                         │
│    ┌─────────────────────────────────────────────────────┐ │
│    │ • Extract token usage from response                 │ │
│    │ • Calculate cost based on model config              │ │
│    │ • Log to SQLite (async)                             │ │
│    │ • Update Prometheus metrics                         │ │
│    └─────────────────────────────────────────────────────┘ │ │
└─────────────────────────────────────────────────────────────┘
     │
     ▼
Client Response
```

## Testing

```bash
# Run all tests
npm test

# Run with coverage
npm run test:coverage

# Watch mode
npm run test:watch
```

Test coverage:
- **Unit tests**: Transformer, metering calculations
- **Integration tests**: Auth middleware, API endpoints

## Deployment

### Docker Compose (Recommended)

```bash
# Start
docker-compose up -d

# View logs
docker-compose logs -f llm-proxy

# Stop
docker-compose down
```

### Native Node.js

```bash
# Build
npm run build

# Run
npm start

# Or with PM2
pm2 start dist/server.js --name llm-proxy
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CONFIG_PATH` | `./config.yaml` | Path to config file |
| `DATABASE_PATH` | `./data/llm_proxy.db` | Path to SQLite database |

## Edge Cases Handled

| Scenario | Response |
|----------|----------|
| Missing API key | `401 Unauthorized` |
| Invalid API key | `401 Unauthorized` |
| Expired API key | `401 Unauthorized` |
| Rate limit exceeded | `429 Too Many Requests` |
| Unknown model | `404 Not Found` |
| Upstream timeout | `504 Gateway Timeout` |
| Upstream error | `502 Bad Gateway` |
| Malformed request | `400 Bad Request` |
| Streaming interruption | Graceful close + partial response |
| Old logs (>90 days) | Auto-deleted on startup |

## Project Structure

```
llm_proxy/
├── src/
│   ├── config/           # Config loading & validation (Zod)
│   │   ├── index.ts
│   │   └── schema.ts
│   ├── db/               # SQLite database
│   │   ├── index.ts      # Connection & migrations
│   │   └── queries.ts    # Query helpers
│   ├── middleware/       # Express middleware
│   │   ├── auth.ts       # API key & admin auth
│   │   ├── rateLimit.ts  # Sliding window rate limiter
│   │   └── logger.ts     # Request logging
│   ├── routes/           # API endpoints
│   │   ├── openai.ts     # /v1/chat/completions
│   │   ├── anthropic.ts  # /v1/messages
│   │   ├── admin.ts      # /admin/*
│   │   └── index.ts      # Route aggregator
│   ├── services/         # Business logic
│   │   ├── proxy.ts      # Upstream request handling
│   │   ├── transformer.ts # Format conversion
│   │   ├── metering.ts   # Usage tracking & cost
│   │   ├── metrics.ts    # Prometheus metrics
│   │   └── index.ts
│   └── server.ts         # Express app bootstrap
├── tests/
│   ├── unit/             # Unit tests
│   │   ├── transformer.test.ts
│   │   └── metering.test.ts
│   └── integration/      # Integration tests
│       └── auth.test.ts
├── docker/
│   └── Dockerfile
├── config.example.yaml   # Config template
├── docker-compose.yml    # Docker deployment
├── package.json
├── tsconfig.json
└── README.md
```

## Comparison with LiteLLM

| Feature | LiteLLM | LLM Proxy |
|---------|---------|-----------|
| **Complexity** | Heavy (1000+ endpoints) | Light (10 endpoints) |
| **Dependencies** | Many external services | SQLite only |
| **UI** | Complex, upsell-heavy | API-only (add HTMX if needed) |
| **Config** | Complex JSON | Simple YAML |
| **Deployment** | Multiple services | Single container |
| **Cost** | Enterprise upsells | Free, MIT licensed |
| **Use Case** | Multi-provider gateway | Local inference proxy |

## Troubleshooting

### "Model not found"
- Check that the model name in your request matches the `name` in `config.yaml`

### "Upstream error"
- Verify sglang/vllm is running on the configured port
- Check the upstream URL in `config.yaml`
- Test directly: `curl http://localhost:3000/v1/chat/completions`

### "Invalid API key"
- Verify you're using the correct key from the `/admin/keys` response
- Check that the key hasn't expired
- Verify the key is active (`is_active = 1` in database)

### Database errors
- Ensure the `data` directory exists and is writable
- Check the database path in `config.yaml`
- SQLite file should be at `./data/llm_proxy.db`

### Docker issues
- Ensure ports 4000 and 9090 are not in use
- Check volume mounts: `./data:/data`
- Verify config.yaml is mounted: `./config.yaml:/config.yaml:ro`

## License

MIT

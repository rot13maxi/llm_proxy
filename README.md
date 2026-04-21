# LLM Proxy

A lightweight, self-hosted LLM proxy/gateway that provides OpenAI and Anthropic-compatible APIs in front of your local inference servers (sglang, vllm, etc.).

**No enterprise upsells. No bloat. Just what you need.**

**Latency-optimized:** Zero external dependencies, in-memory rate limiting, API key caching, connection pooling.

## Features

- ✅ **OpenAI-compatible endpoint** (`/v1/chat/completions`) with streaming
- ✅ **Anthropic-compatible endpoint** (`/v1/messages`)
- ✅ **API key management** - create, list, delete, expire
- ✅ **Rate limiting** - per-key, configurable (RPM/TPM), in-memory
- ✅ **Usage tracking** - SQLite, 90-day retention (configurable)
- ✅ **Cost metering** - configurable per-model costs
- ✅ **Admin API** - REST endpoints for dashboard
- ✅ **Prometheus metrics** - `/metrics` endpoint
- ✅ **Zero external dependencies** - SQLite only, single container

## Quick Start

### 1. Configure

```bash
cp config.example.yaml config.yaml
nano config.yaml  # Change admin password!
```

### 2. Run

```bash
# Development (hot reload)
npm run dev

# Production (built)
npm run build && npm start

# Docker (recommended)
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
  
  # Option 2: API Key (use X-Admin-Key header, recommended)
  # api_key: sk-admin-$(openssl rand -hex 48)

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

### Generate Secure Password

```bash
openssl rand -base64 32
# or
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
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

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/admin/keys` | GET | List all API keys with usage stats |
| `/admin/keys` | POST | Create a new API key |
| `/admin/keys/:id` | DELETE | Revoke an API key |
| `/admin/usage?days=7` | GET | System-wide usage statistics |
| `/admin/keys/:id/usage?days=7` | GET | Usage for a specific API key |
| `/admin/logs?limit=100` | GET | Recent request logs |
| `/admin/models` | GET | List configured models |
| `/admin/health` | GET | Health check endpoint |
| `/metrics` | GET | Prometheus metrics (no auth) |

### Create API Key

```json
{
  "name": "production-key",
  "expiresAt": "2025-12-31",
  "rateLimitRpm": 100,
  "rateLimitTpm": 200000
}
```

## Deployment

### Docker Compose (Recommended)

```bash
# Start
docker-compose up -d

# View logs
docker-compose logs -f llm-proxy

# Stop
docker-compose down

# Update
git pull && docker-compose build && docker-compose up -d
```

### Docker Compose Production

```bash
docker compose -f docker-compose.prod.yml build
docker compose -f docker-compose.prod.yml up -d
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

### Docker Multi-Service Setup

#### With sglang

```yaml
version: '3.8'

services:
  llm-proxy:
    build: .
    ports:
      - "4000:4000"
    volumes:
      - ./data:/data
      - ./config.yaml:/config.yaml:ro
    depends_on:
      - sglang

  sglang:
    image: sglangai/sglang:latest
    ports:
      - "3000:3000"
    volumes:
      - ./models:/models
    command: --model /models/qwen-2.5-7b --port 3000
```

#### With vllm

```yaml
version: '3.8'

services:
  llm-proxy:
    build: .
    ports:
      - "4000:4000"
    volumes:
      - ./data:/data
      - ./config.yaml:/config.yaml:ro
    depends_on:
      - vllm

  vllm:
    image: vllm/vllm:latest
    ports:
      - "8000:8000"
    volumes:
      - ./models:/models
    command: --model /models/qwen-2.5-7b --port 8000
```

### Security Checklist

- [ ] Admin password changed (or API key configured)
- [ ] HTTPS enabled (via reverse proxy)
- [ ] Admin endpoint not publicly exposed
- [ ] config.yaml not committed to git
- [ ] Database backups configured

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
│  │  Middleware Stack (optimized for latency)               │   │
│  │  1. requestLogger (async, non-blocking)                │   │
│  │  2. apiKeyAuth (cached, plaintext, ~0ms)               │   │
│  │  3. rateLimit (in-memory sliding window)               │   │
│  │  4. adminAuth (timing-safe comparison)                 │   │
│  └─────────────────────────────────────────────────────────┘   │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │  Routes                                                  │   │
│  │  • /v1/chat/completions → OpenAI proxy                 │   │
│  │  • /v1/messages → Anthropic proxy                      │   │
│  │  • /admin/* → Dashboard API                             │   │
│  │  • /metrics → Prometheus metrics                        │   │
│  └─────────────────────────────────────────────────────────┘   │
└─────────────────────────────┼──────────────────────────────────┘
                              │
┌─────────────────────────────┼──────────────────────────────────┐
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

### Latency Optimizations

- **API key caching:** 5-minute TTL, ~0ms for cached lookups
- **Plaintext API keys:** No hashing (keys are random UUIDs)
- **In-memory rate limiting:** No database overhead
- **Connection pooling:** HTTP keep-alive with upstream servers
- **Async logging:** Usage logged after response sent

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

## Testing

```bash
# Run all tests
npm test

# Run with coverage
npm run test:coverage

# Watch mode
npm run test:watch
```

## Troubleshooting

### "Model not found"
Check that the model name in your request matches the `name` in `config.yaml`.

### "Upstream error"
1. Verify sglang/vllm is running on the configured port
2. Check the upstream URL in `config.yaml`
3. Test directly: `curl http://localhost:3000/v1/chat/completions`

### "Invalid API key"
1. Verify you're using the correct key from the `/admin/keys` response
2. Check that the key hasn't expired
3. Verify the key is active (`is_active = 1` in database)

### Database errors
1. Ensure the `data` directory exists and is writable
2. Check the database path in `config.yaml`
3. SQLite file should be at `./data/llm_proxy.db`

### Docker issues
1. Ensure ports 4000 and 9090 are not in use: `lsof -i :4000`
2. Check volume mounts: `./data:/data`
3. Verify config.yaml is mounted: `./config.yaml:/config.yaml:ro`
4. Check logs: `docker-compose logs -f`

## Comparison with LiteLLM

| Feature | LiteLLM | LLM Proxy |
|---------|---------|-----------|
| **Complexity** | Heavy (1000+ endpoints) | Light (10 endpoints) |
| **Dependencies** | Many external services | SQLite only |
| **UI** | Complex, upsell-heavy | API-only |
| **Config** | Complex JSON | Simple YAML |
| **Deployment** | Multiple services | Single container |
| **Cost** | Enterprise upsells | Free, MIT licensed |
| **Use Case** | Multi-provider gateway | Local inference proxy |
| **Latency** | Higher (more layers) | Minimal (optimized) |

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
│   │   ├── auth.ts       # API key & admin auth (cached)
│   │   ├── rateLimit.ts  # In-memory sliding window
│   │   └── logger.ts     # Request logging (async)
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
├── config.example.yaml   # Config template
├── docker-compose.yml    # Docker deployment
├── package.json
├── tsconfig.json
└── README.md
```

## License

MIT

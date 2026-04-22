# LLM Proxy

A lightweight, self-hosted LLM proxy/gateway that provides OpenAI and Anthropic-compatible APIs in front of your local inference servers (sglang, vllm, etc.).

**No enterprise upsells. No bloat. Just what you need.**

**Latency-optimized:** Zero external dependencies, in-memory rate limiting, API key caching, connection pooling.

## Features

- ✅ **OpenAI-compatible endpoint** (`/v1/chat/completions`) with streaming
- ✅ **Anthropic-compatible endpoint** (`/v1/messages`)
- ✅ **Model aliases** — route `current` (or any alias) to a different backend at runtime
- ✅ **Optional Docker orchestration** — flipping an alias can stop the old model container and start the new one (single-GPU setups)
- ✅ **Scale-to-zero** — auto-stop idle containers, auto-start on demand
- ✅ **API key management** — create, list, delete, rotate, expire
- ✅ **Rate limiting** — per-key, configurable (RPM/TPM), in-memory
- ✅ **Usage tracking** — SQLite, 90-day retention (configurable); streaming requests metered via SSE `usage` chunks
- ✅ **Cost metering** — configurable per-model costs
- ✅ **Admin dashboard** — six themeable UIs (Paper Punch, Classic Pop, CRT Terminal, Swiss Editorial, Memphis Arcade, Industrial Hardware), picker persists to localStorage
- ✅ **Filterable metrics** — by time range, API key, tag, and/or model, applied consistently across totals, charts, and top-keys
- ✅ **Prometheus metrics** — `/metrics` endpoint
- ✅ **Zero external dependencies** — SQLite only, single container

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

A complete reference of every block you can set in `config.yaml`. Only `server`,
`database`, `admin`, and `models` are required — everything else is opt-in.

```yaml
# config.yaml

server:
  port: 4000              # int, default 4000 (0 = random)
  host: 0.0.0.0           # string, default 0.0.0.0

database:
  path: ./data/llm_proxy.db   # string, default ./data/llm_proxy.db
  retention_days: 90          # int, default 90 — old usage logs pruned on startup

admin:
  # Pick ONE of the two auth methods (or provide both):
  # Option 1: Basic Auth (shown in the dashboard's login overlay)
  username: admin
  password: change_me_to_secure_password

  # Option 2: Admin API key (sent as X-Admin-Key header)
  # api_key: sk-admin-$(openssl rand -hex 48)

models:
  # Minimal model entry
  - name: qwen-2.5-7b
    upstream: http://localhost:3000/v1/chat/completions
    cost_per_1k_input: 0.001
    cost_per_1k_output: 0.002

  # Full model entry with optional blocks
  - name: qwen-2.5-32b
    upstream: http://sglang-32b:3000/v1/chat/completions
    cost_per_1k_input: 0.002
    cost_per_1k_output: 0.004

    # Optional: scale-to-zero — auto-stop after idle, auto-start on request
    scale_to_zero:
      enabled: true
      container_name: sglang-32b     # Docker container to control (required when enabled)
      backend_port: 3000             # Port used for health probes (default 8000)
      idle_timeout_minutes: 30       # Stop after N minutes of inactivity (default 30)
      start_timeout_seconds: 360     # Max wait for container to become healthy (default 360)
      health_check_path: /health     # Probe path (default /health)
      health_check_interval_ms: 2000 # Poll interval during startup (default 2000)

    # Optional: docker container backing this model — required for alias flipping to
    # physically swap models in/out (see `aliases:` below). Safe to omit if you run
    # all models simultaneously or use scale-to-zero instead.
    container:
      name: sglang-32b                            # Docker container name
      health_url: http://sglang-32b:3000/health   # Optional; defaults to {upstream_origin}/health
      start_timeout_seconds: 360                  # Optional; default 360

# Optional: model aliases. Clients can POST to a stable name (e.g. "current") and
# the proxy routes to whichever model the alias currently targets. You can flip
# the target at runtime from the landing page (requires admin auth) or via the
# admin API. If the target model has a `container:` block, flipping will stop the
# old container, start the new one, and wait for it to become healthy — useful
# for single-GPU setups where only one model fits at a time.
#
# Usage reports aggregate against the RESOLVED model (e.g. "qwen-2.5-7b"), not
# the alias name, so stats stay meaningful across retargets.
aliases:
  - name: current
    target: qwen-2.5-7b      # Initial target; overridable at runtime (persisted in SQLite)

rate_limits:
  default:
    requests_per_minute: 60       # Applied to any key that doesn't override via rate_limit_rpm
    tokens_per_minute: 100000
```

### Generate Secure Password

```bash
openssl rand -base64 32
# or
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### Enabling Docker Orchestration

Both `scale_to_zero` and alias `container` blocks talk to Docker via the host's
Unix socket. If you run `llm_proxy` itself as a container, mount the socket:

```yaml
# docker-compose.yml
services:
  llm-proxy:
    # ...
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
```

If no model has `container:` or `scale_to_zero:` set, the proxy never touches
Docker and the socket mount is unnecessary.

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

### Public Endpoints (no auth)

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/` | GET | Landing page — status, models, prices, alias picker |
| `/health` | GET | Health check (used by Docker healthcheck) |
| `/models` | GET | Read-only JSON list of configured models + prices |
| `/aliases` | GET | Read-only JSON list of configured aliases + current targets |
| `/metrics` | GET | Prometheus metrics |

### Admin Endpoints

All admin endpoints require authentication via:
- Basic Auth: `-u username:password`
- API Key: `-H "X-Admin-Key: <admin_api_key>"`

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/admin` | GET | Admin dashboard HTML (login overlay renders client-side) |
| `/admin/dashboard` | GET | JSON dashboard summary (today/week totals) |
| `/admin/keys` | GET | List all API keys with usage stats |
| `/admin/keys` | POST | Create a new API key |
| `/admin/keys/:id` | DELETE | Revoke an API key |
| `/admin/keys/:id/rotate` | POST | Rotate an API key (new value, same metadata) |
| `/admin/keys/:id/usage?days=7` | GET | Usage for a specific API key |
| `/admin/usage?days=7` | GET | System-wide usage totals |
| `/admin/metrics?days=7&model=&apiKeyId=&tag=` | GET | Filterable metrics (totals, byModel, dailyStats, topApiKeys) |
| `/admin/metrics/hourly?hours=1` | GET | Hourly usage stats |
| `/admin/logs?limit=100` | GET | Recent request logs |
| `/admin/models` | GET | List configured models |
| `/admin/aliases` | GET | List aliases with current targets + whether orchestration is enabled |
| `/admin/aliases/:name` | PUT | Retarget an alias (`{"target": "model-x"}`). Performs container flip if orchestration is configured. |
| `/admin/filters/api-keys` | GET | Distinct API keys for filter dropdowns |
| `/admin/filters/models` | GET | Distinct models for filter dropdowns |
| `/admin/health` | GET | Authed health check (alias of `/health`) |

### Create API Key

```json
{
  "name": "production-key",
  "expiresAt": "2025-12-31",
  "rateLimitRpm": 100,
  "rateLimitTpm": 200000,
  "tags": "team-red,prod"
}
```

### Flip an Alias

```bash
curl -X PUT http://localhost:4000/admin/aliases/current \
  -u admin:your_password \
  -H "Content-Type: application/json" \
  -d '{"target": "qwen-2.5-32b"}'
```

If the target model has a `container:` block, this call blocks until the old
container stops, the new one starts, and its health endpoint responds (or the
`start_timeout_seconds` is hit, in which case the alias is *not* flipped and
you get a `504`). Expect a brief outage during the swap — documented tradeoff
for single-GPU setups.

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
      # Required ONLY if you use scale_to_zero or alias container orchestration.
      - /var/run/docker.sock:/var/run/docker.sock
    depends_on:
      - sglang

  sglang:
    image: sglangai/sglang:latest
    container_name: sglang       # Must match `container.name` in config.yaml if orchestrating
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
│   ├── config/              # Config loading & validation (Zod)
│   │   ├── index.ts
│   │   └── schema.ts        # Models, aliases, containers, scale_to_zero, admin
│   ├── db/                  # SQLite
│   │   ├── index.ts         # Connection & migrations
│   │   └── queries.ts       # Filterable metric queries, aliases, keys, logs
│   ├── middleware/
│   │   ├── auth.ts          # API key & admin auth (cached)
│   │   ├── rateLimit.ts     # In-memory sliding window
│   │   └── logger.ts        # Request logging (async)
│   ├── routes/
│   │   ├── openai.ts        # /v1/chat/completions (streaming + non-streaming)
│   │   ├── anthropic.ts     # /v1/messages
│   │   ├── admin.ts         # /admin/* (keys, metrics, aliases)
│   │   └── index.ts
│   ├── services/
│   │   ├── proxy.ts         # Upstream forwarding, SSE metering, alias resolution
│   │   ├── transformer.ts   # OpenAI ↔ Anthropic format conversion
│   │   ├── metering.ts      # Usage tracking & cost calculation
│   │   ├── metrics.ts       # Prometheus exporter
│   │   ├── scaleToZero.ts   # Idle container auto-stop / start
│   │   ├── orchestrator.ts  # Alias-driven container flipping
│   │   └── index.ts
│   ├── ui/
│   │   ├── index.html       # Admin dashboard (themeable)
│   │   ├── themes/          # base.css + 6 theme stylesheets + picker.js
│   │   └── mockups/         # Standalone theme previews
│   └── server.ts            # Express bootstrap + landing page HTML
├── tests/
│   ├── unit/                # Transformer, metering, rate-limiter
│   └── integration/         # Auth, proxy, streaming, aliases, metrics-filters, UI
├── config.example.yaml      # Config template
├── docker-compose.yml       # Default deployment (docker socket optional)
├── DESIGN.md                # Design system notes
├── package.json
├── tsconfig.json
└── README.md
```

## License

MIT

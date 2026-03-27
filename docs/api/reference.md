# API Reference

## Base URLs

- **API**: `http://localhost:4000/v1`
- **Admin**: `http://localhost:4000/admin`
- **Metrics**: `http://localhost:4000/metrics`

---

## OpenAI-Compatible Endpoints

### POST /v1/chat/completions

Create a chat completion.

**Headers:**
```
Authorization: Bearer sk-xxx
Content-Type: application/json
```

**Request:**
```json
{
  "model": "qwen-2.5-7b",
  "messages": [
    {"role": "user", "content": "Hello"}
  ],
  "temperature": 0.7,
  "max_tokens": 100
}
```

**Response:**
```json
{
  "id": "chat-xxx",
  "choices": [{
    "index": 0,
    "message": {"role": "assistant", "content": "Hi there!"},
    "finish_reason": "stop"
  }],
  "usage": {
    "prompt_tokens": 10,
    "completion_tokens": 5,
    "total_tokens": 15
  },
  "model": "qwen-2.5-7b"
}
```

**Streaming:**
```json
{
  "model": "qwen-2.5-7b",
  "messages": [...],
  "stream": true
}
```

Response is Server-Sent Events (SSE):
```
data: {"id":"xxx","choices":[{"delta":{"content":"Hello"}}]}

data: {"id":"xxx","choices":[{"finish_reason":"stop"}],"usage":{...}}

```

---

## Anthropic-Compatible Endpoints

### POST /v1/messages

Create a message (Anthropic format).

**Headers:**
```
Authorization: Bearer sk-xxx
Content-Type: application/json
```

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
  "model": "qwen-2.5-7b",
  "usage": {
    "input_tokens": 10,
    "output_tokens": 5
  }
}
```

---

## Admin Endpoints

### GET /admin

Dashboard overview.

**Headers:**
```
Authorization: Basic admin:password
# or
X-Admin-Key: your_master_key
```

**Response:**
```json
{
  "dashboard": {
    "today": {
      "requests": 150,
      "tokens": 45000,
      "cost": 0.125
    },
    "week": {...},
    "models": [...]
  }
}
```

---

### GET /admin/keys

List all API keys with usage stats.

**Response:**
```json
{
  "keys": [{
    "id": 1,
    "name": "my-app",
    "created_at": "2026-03-23T...",
    "expires_at": null,
    "is_active": true,
    "usage": {
      "requests": 150,
      "tokens": 45000,
      "cost": 0.125
    }
  }]
}
```

---

### POST /admin/keys

Create a new API key.

**Request:**
```json
{
  "name": "my-app",
  "expiresAt": "2026-12-31T23:59:59Z",
  "rateLimitRpm": 100,
  "rateLimitTpm": 200000
}
```

**Response:**
```json
{
  "id": 1,
  "key": "sk-96acfe3e-5890-4f9b-8ae2-06ecc6fefd6b",
  "name": "my-app",
  "created_at": "2026-03-23T..."
}
```

⚠️ **Note**: The `key` field is only returned once!

---

### DELETE /admin/keys/:id

Revoke an API key.

**Response:** `204 No Content`

---

### GET /admin/models

List configured models.

**Response:**
```json
{
  "models": [{
    "name": "qwen-2.5-7b",
    "upstream": "http://localhost:3000/v1/chat/completions",
    "costPer1kInput": 0.001,
    "costPer1kOutput": 0.002
  }]
}
```

---

### GET /admin/usage

Get system-wide usage statistics.

**Query Parameters:**
- `days` (optional): Number of days to aggregate (default: 7)

**Response:**
```json
{
  "period": 7,
  "totalRequests": 1500,
  "totalInputTokens": 450000,
  "totalOutputTokens": 225000,
  "totalCost": 1.25,
  "byModel": [...]
}
```

---

### GET /admin/keys/:id/usage

Get usage for a specific API key.

**Query Parameters:**
- `days` (optional): Number of days (default: 7)

**Response:**
```json
{
  "totalRequests": 150,
  "totalInputTokens": 45000,
  "totalOutputTokens": 22500,
  "totalCost": 0.125,
  "dailyBreakdown": [...]
}
```

---

### GET /admin/logs

Get recent request logs.

**Query Parameters:**
- `limit` (optional): Number of logs (default: 100)

**Response:**
```json
{
  "logs": [{
    "id": 1,
    "apiKeyName": "my-app",
    "model": "qwen-2.5-7b",
    "timestamp": "2026-03-23T...",
    "inputTokens": 100,
    "outputTokens": 50,
    "latencyMs": 250,
    "statusCode": 200,
    "cost": 0.0002
  }]
}
```

---

### GET /admin/health

Health check endpoint.

**Response:**
```json
{
  "status": "ok",
  "timestamp": "2026-03-23T..."
}
```

---

## Prometheus Metrics

### GET /metrics

Returns Prometheus-format metrics.

**Available Metrics:**

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `llm_proxy_requests_total` | Counter | endpoint, status, model | Total requests |
| `llm_proxy_tokens_total` | Counter | model, type | Total tokens (input/output) |
| `llm_proxy_latency_seconds` | Histogram | endpoint, model | Request latency |
| `llm_proxy_cost_total` | Counter | model | Total cost in USD |
| `llm_proxy_api_keys_active` | Gauge | - | Number of active API keys |

**Example:**
```
# HELP llm_proxy_requests_total Total number of requests
# TYPE llm_proxy_requests_total counter
llm_proxy_requests_total{endpoint="/v1/chat/completions",status="200",model="qwen-2.5-7b"} 150
```

---

## Error Responses

### 400 Bad Request
```json
{
  "error": {
    "message": "model is required",
    "code": "invalid_request_error"
  }
}
```

### 401 Unauthorized
```json
{
  "error": {
    "message": "Invalid API key",
    "code": "invalid_api_key"
  }
}
```

### 404 Not Found
```json
{
  "error": {
    "message": "Model not found: unknown-model",
    "code": "model_not_found"
  }
}
```

### 429 Rate Limit Exceeded
```json
{
  "error": {
    "message": "Rate limit exceeded",
    "code": "rate_limit_exceeded",
    "retry_after": 60
  },
  "limit": {"rpm": 60, "tpm": 100000},
  "current": {"requests": 60, "tokens": 95000}
}
```

### 500 Internal Server Error
```json
{
  "error": {
    "message": "Internal server error",
    "code": "internal_error"
  }
}
```

### 502 Bad Gateway
```json
{
  "error": {
    "message": "Upstream error",
    "code": "upstream_error"
  }
}
```

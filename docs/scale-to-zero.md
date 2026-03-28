# Scale-to-Zero

The LLM Proxy includes an optional scale-to-zero feature that automatically starts and stops backend inference containers based on demand.

## Overview

When enabled for a model, the proxy will:
1. **Start** the backend container on the first request after it's stopped
2. **Wait** for the container to become healthy before serving requests
3. **Stop** the container after a configurable idle timeout
4. **Return 503** if a request arrives while the container is starting

This allows you to save GPU resources by not running inference servers when they're not being used.

## Configuration

Scale-to-zero is configured per-model in your `config.yaml`:

```yaml
models:
  - name: qwen3.5-27b
    upstream: http://sglang-27b:8001/v1/chat/completions
    cost_per_1k_input: 0.000195
    cost_per_1k_output: 0.00156
    scale_to_zero:
      enabled: true
      container_name: sglang-27b
      idle_timeout_minutes: 30
      start_timeout_seconds: 120
      health_check_path: /health
      health_check_interval_ms: 2000
```

### Configuration Options

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `enabled` | Yes | - | Enable/disable scale-to-zero for this model |
| `container_name` | Yes (if enabled) | - | Docker container name to control |
| `idle_timeout_minutes` | No | 30 | Minutes of inactivity before stopping |
| `start_timeout_seconds` | No | 360 | Max seconds to wait for container to become healthy |
| `health_check_path` | No | `/health` | Endpoint to check if backend is ready |
| `health_check_interval_ms` | No | 2000 | Milliseconds between health checks during startup |

## Requirements

1. **Docker socket access**: The container must have access to `/var/run/docker.sock`
2. **Backend health endpoint**: Your inference server must expose a health check endpoint (default: `/health`)
3. **Container naming**: Docker container names must match the `container_name` config

### Docker Compose Example

```yaml
services:
  llm-proxy:
    build: .
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock  # Required for scale-to-zero
      - ./config.yaml:/config.yaml
    ports:
      - "4000:4000"

  sglang-27b:
    image: your-sglang-image
    container_name: sglang-27b  # Must match config
    # ... rest of config
    restart: "no"  # Important: let proxy control lifecycle
```

## Behavior

### Startup Flow

1. Request arrives for a model with scale-to-zero enabled
2. Proxy checks if container is running and healthy
3. If not, proxy starts the container via Docker API
4. Proxy polls health endpoint until healthy or timeout
5. Request is forwarded to backend
6. Idle timer is reset

### Shutdown Flow

1. No requests for `idle_timeout_minutes`
2. Proxy stops the container via Docker API
3. Next request triggers startup flow again

### Error Handling

- **503 Service Unavailable**: Returned when backend is starting and request can't wait
- **Container start failure**: Logged to proxy logs, 503 returned
- **Health check timeout**: Container remains running, 503 returned

## Migration from sglang-proxy

If you're migrating from a separate sglang-proxy:

1. Update `upstream` URLs to point directly to inference servers (not the proxy)
2. Add `scale_to_zero` config for each model
3. Set `container_name` to match your Docker container names
4. Mount Docker socket to llm-proxy container
5. Set `restart: "no"` on inference containers
6. Remove sglang-proxy services from docker-compose

### Before (with sglang-proxy)

```yaml
models:
  - name: qwen3.5-27b
    upstream: http://sglang-27b-proxy:18001/v1/chat/completions
```

### After (integrated scale-to-zero)

```yaml
models:
  - name: qwen3.5-27b
    upstream: http://sglang-27b:8001/v1/chat/completions
    scale_to_zero:
      enabled: true
      container_name: sglang-27b
      idle_timeout_minutes: 30
```

## Troubleshooting

### Container won't start
- Check Docker socket is mounted: `docker inspect llm-proxy | grep docker.sock`
- Check container name matches config
- Check inference container can start standalone

### Health checks failing
- Verify health endpoint exists: `curl http://sglang-27b:8001/health`
- Check `health_check_path` matches your server's endpoint
- Increase `start_timeout_seconds` for slow-starting models

### Container doesn't stop
- Check `idle_timeout_minutes` value
- Verify no background requests are hitting the endpoint
- Check proxy logs: `docker logs llm-proxy | grep ScaleToZero`

## Performance Considerations

- **Cold start latency**: First request after startup waits for container to initialize (typically 30-180 seconds)
- **GPU utilization**: Scale-to-zero maximizes GPU availability for other workloads
- **Best for**: Intermittent usage patterns, development/testing, multi-tenant setups
- **Not ideal for**: High-throughput production with constant traffic

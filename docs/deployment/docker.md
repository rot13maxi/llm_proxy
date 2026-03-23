# Docker Deployment

## Quick Start

```bash
# Clone repository
git clone https://github.com/rot13maxi/llm_proxy.git
cd llm_proxy

# Copy and configure
cp config.example.yaml config.yaml
# Edit config.yaml (change admin password!)

# Run with Docker Compose
docker-compose up -d
```

## Configuration

### docker-compose.yml

```yaml
version: '3.8'

services:
  llm-proxy:
    build:
      context: .
      dockerfile: docker/Dockerfile
    ports:
      - "4000:4000"   # API port
      - "9090:9090"   # Metrics port
    volumes:
      - ./data:/data              # Database persistence
      - ./config.yaml:/config.yaml:ro  # Config (read-only)
    environment:
      - DATABASE_PATH=/data/llm_proxy.db
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "wget", "--no-verbose", "--tries=1", "--spider", "http://localhost:4000/admin/health"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 10s
```

### config.yaml

```yaml
server:
  port: 4000
  host: 0.0.0.0

database:
  path: ./data/llm_proxy.db
  retention_days: 90

admin:
  username: admin
  password: change_me_to_secure_password

models:
  - name: qwen-2.5-7b
    upstream: http://sglang:3000/v1/chat/completions
    cost_per_1k_input: 0.001
    cost_per_1k_output: 0.002

rate_limits:
  default:
    requests_per_minute: 60
    tokens_per_minute: 100000
```

## Multi-Service Setup

### With sglang

```yaml
version: '3.8'

services:
  llm-proxy:
    build: ./
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

### With vllm

```yaml
version: '3.8'

services:
  llm-proxy:
    build: ./
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

## Production Considerations

### Security

1. **Change Default Password**: Always change the admin password in `config.yaml`
2. **Config File Permissions**: `chmod 600 config.yaml`
3. **Network Isolation**: Use Docker networks to isolate services
4. **TLS Termination**: Consider reverse proxy (nginx, traefik) for TLS

### Monitoring

```yaml
services:
  prometheus:
    image: prom/prometheus
    ports:
      - "9090:9090"
    volumes:
      - ./prometheus.yml:/etc/prometheus/prometheus.yml
      - prometheus_data:/prometheus

  grafana:
    image: grafana/grafana
    ports:
      - "3000:3000"
    volumes:
      - grafana_data:/var/lib/grafana
    depends_on:
      - prometheus
```

### Scaling

For horizontal scaling, use Redis for shared rate limiting:

```yaml
services:
  redis:
    image: redis:alpine
    ports:
      - "6379:6379"

  llm-proxy:
    # ... config
    environment:
      - RATE_LIMIT_REDIS_URL=redis://redis:6379
```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `DATABASE_PATH` | SQLite database path | `./data/llm_proxy.db` |
| `CONFIG_PATH` | Config file path | `./config.yaml` |

## Health Checks

```bash
# Check proxy health
curl http://localhost:4000/admin/health

# Check metrics endpoint
curl http://localhost:4000/metrics

# Check upstream connectivity
curl http://localhost:4000/v1/models -H "Authorization: Bearer sk-xxx"
```

## Logs

```bash
# View logs
docker-compose logs -f llm-proxy

# View specific log level (if configured)
docker-compose logs llm-proxy | grep ERROR
```

## Backup

```bash
# Backup database
docker-compose exec llm-proxy cp /data/llm_proxy.db ./backup.db

# Restore database
docker-compose exec llm-proxy cp ./backup.db /data/llm_proxy.db
```

## Troubleshooting

### Database Locked

```bash
# Check for zombie processes
docker-compose ps

# Restart container
docker-compose restart llm-proxy
```

### Upstream Connection Failed

Check upstream service is running:
```bash
docker-compose ps
curl http://sglang:3000/v1/models
```

### Port Already in Use

Change port in `docker-compose.yml`:
```yaml
ports:
  - "4001:4000"  # Use different host port
```

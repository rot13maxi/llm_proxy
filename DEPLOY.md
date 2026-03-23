# Deployment Guide

## Quick Deploy

```bash
cp config.example.yaml config.yaml
nano config.yaml  # Change admin password
./deploy.sh       # Choose production mode
```

## Configuration

Edit `config.yaml`:

```yaml
admin:
  username: admin
  password: YOUR_SECURE_PASSWORD  # ← CHANGE THIS!

models:
  - name: qwen-2.5-7b
    upstream: http://host.docker.internal:3000/v1/chat/completions
```

## Generate Password

```bash
openssl rand -base64 32
```

## Access

- Dashboard: http://localhost:4000/admin
- API: http://localhost:4000/v1/chat/completions

## Troubleshooting

```bash
# Check logs
docker compose logs

# Check if port is in use
lsof -i :4000

# Restart
docker compose restart
```

## Production Features

- ✅ Binds to localhost only
- ✅ Non-root user
- ✅ Resource limits
- ✅ Log rotation
- ✅ Health checks
- ✅ Auto-restart

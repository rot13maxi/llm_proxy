# Production Deployment Guide

## Admin Password Setup

### Option 1: Basic Auth

Edit `config.yaml`:

```yaml
admin:
  username: admin
  password: YOUR_SECURE_PASSWORD
```

Generate password:
```bash
openssl rand -base64 32
```

### Option 2: API Key (Recommended)

```yaml
admin:
  api_key: sk-admin-$(openssl rand -hex 48)
```

Use via header:
```bash
curl -H "X-Admin-Key: sk-admin-..." http://localhost:4000/admin/keys
```

## Docker Deployment

### Production

```bash
docker compose -f docker-compose.prod.yml build
docker compose -f docker-compose.prod.yml up -d
```

### Verify

```bash
curl http://localhost:4000/admin/health -u admin:YOUR_PASSWORD
```

## Security Checklist

- [ ] Admin password changed
- [ ] HTTPS enabled (via reverse proxy)
- [ ] Admin endpoint not publicly exposed
- [ ] config.yaml not committed to git
- [ ] Database backups configured

## Common Commands

```bash
# View logs
docker compose logs -f

# Stop
docker compose down

# Update
git pull
docker compose build
docker compose up -d
```

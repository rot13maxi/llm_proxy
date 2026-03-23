# Docker Deployment - The Simple Way

## One-Command Deploy

```bash
# 1. Configure
cp config.example.yaml config.yaml
nano config.yaml  # Change the admin password

# 2. Deploy
./deploy.sh

# 3. Choose "1" for production mode
```

## What the Script Does

1. ✅ Validates config.yaml exists
2. ✅ Warns if password is still default
3. ✅ Builds Docker image
4. ✅ Starts container
5. ✅ Waits for health check
6. ✅ Shows access URLs

## Manual Deploy

### Production

```bash
docker compose -f docker-compose.prod.yml build
docker compose -f docker-compose.prod.yml up -d
curl http://localhost:4000/admin/health -u admin:YOUR_PASSWORD
```

### Development

```bash
docker compose build
docker compose up -d
```

## Access URLs

- **Dashboard**: http://localhost:4000/admin
- **API**: http://localhost:4000/v1/chat/completions
- **Metrics**: http://localhost:4000/metrics

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

## Generate Password

```bash
openssl rand -base64 32
# or
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

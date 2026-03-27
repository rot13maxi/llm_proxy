# Stage 1: Build
FROM node:22-alpine AS builder

WORKDIR /app

RUN apk add --no-cache python3 g++ make

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# Stage 2: Production
FROM node:22-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production && npm cache clean --force

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/src/ui ./src/ui

RUN if [ -f config.yaml ]; then cp config.yaml /app/config.yaml; fi

# Create docker group with host's docker GID (125) for Docker socket access
RUN addgroup -g 125 docker

RUN mkdir -p /data && chown -R node:node /app /data

USER node

EXPOSE 4000 9090

HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:4000/admin/health || exit 1

CMD ["node", "dist/server.js"]

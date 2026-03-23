FROM node:22-alpine

# Install build dependencies for better-sqlite3
RUN apk add --no-cache python3 g++ make

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install all dependencies (including devDependencies for build)
RUN npm ci

# Copy source and build
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# Remove devDependencies for smaller production image
RUN npm ci --only=production && npm cache clean --force

# Copy config if exists
COPY --chmod=644 config.yaml ./ 2>/dev/null || true

# Create data directory
RUN mkdir -p /data

# Expose ports
EXPOSE 4000 9090

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:4000/admin/health || exit 1

CMD ["node", "dist/server.js"]

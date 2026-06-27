# SpeedVox server image. Builds native modules from source if no prebuilt binary
# is available for the platform.
FROM node:20-bookworm-slim

# Build tools for native modules (better-sqlite3, deasync).
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install dependencies first for better layer caching.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# App source.
COPY . .

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

# Persist the SQLite database, uploaded media and VAPID keys.
VOLUME ["/app/data", "/app/uploads"]

# Simple container healthcheck.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["./node_modules/.bin/pm2-runtime", "ecosystem.config.js"]

# Streaming rainflow / Palmgren-Miner backend
# node:20-slim base, per requirement. better-sqlite3 is a native addon; we use
# its prebuilt binary and only need python3/make/g++ as a fallback if a prebuild
# for this arch is unavailable.
FROM node:20-slim

# Build toolchain for the native addon (better-sqlite3).
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install deps first for better layer caching (all deps, for the build step).
COPY package*.json ./
RUN npm install

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Keep production deps only for the runtime image.
RUN npm prune --omit=dev

ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0
ENV DB_PATH=/data/rainflow.db

EXPOSE 3000

# A named volume is mounted at /data (see docker-compose.yml), so the SQLite
# file and its WAL survive container restarts and recreations.
VOLUME ["/data"]

CMD ["node", "dist/server.js"]

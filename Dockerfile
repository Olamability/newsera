# syntax=docker/dockerfile:1.7
# ============================================================================
# rss-worker:v2 — production image
# ----------------------------------------------------------------------------
# Multi-stage build keeps the runtime image small (no npm cache, no dev
# dependencies). The worker is the lease-based v2 ingestion runtime defined
# in rss-engine/workers/rss-worker.ts and orchestrated via tsx.
# ============================================================================

# ---------- Stage 1: install dependencies ----------------------------------
FROM node:20-alpine AS deps

WORKDIR /app

# Copy only the manifest first so Docker can cache the install layer.
COPY rss-engine/package.json rss-engine/package-lock.json* ./rss-engine/

WORKDIR /app/rss-engine
RUN npm ci --omit=optional --no-audit --no-fund \
 && npm cache clean --force

# ---------- Stage 2: runtime image ----------------------------------------
FROM node:20-alpine AS runtime

# Tini gives us PID 1 signal handling so SIGTERM is propagated to the
# Node process and the worker's graceful shutdown logic runs.
RUN apk add --no-cache tini

ENV NODE_ENV=production \
    NODE_OPTIONS="--enable-source-maps" \
    NPM_CONFIG_LOGLEVEL=warn

WORKDIR /app

# Install the source AFTER node_modules so source edits don't bust the
# (much heavier) dependency layer.
COPY --from=deps /app/rss-engine/node_modules ./rss-engine/node_modules
COPY rss-engine ./rss-engine

WORKDIR /app/rss-engine

# Run as a non-root user. node:alpine ships with the `node` user.
RUN chown -R node:node /app
USER node

# Lightweight in-container healthcheck. Uses the get_ingestion_health() RPC
# (migration 057) with a fallback to a direct heartbeat probe so the image
# stays useful even if the migration hasn't been applied yet.
HEALTHCHECK --interval=60s --timeout=15s --start-period=45s --retries=3 \
  CMD node scripts/healthcheck.js || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["npm", "run", "worker:v2"]

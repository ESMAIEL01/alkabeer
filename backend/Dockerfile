# syntax=docker/dockerfile:1.7
# Multi-stage Node 20 image for Fly.io.
# Final image runs as a non-root user, with only production deps.

ARG NODE_VERSION=20.18.1

# ---- Build stage --------------------------------------------------------
FROM node:${NODE_VERSION}-alpine AS deps
WORKDIR /app

# Native build deps for any optional binary modules (none currently, but cheap).
RUN apk add --no-cache python3 make g++

COPY package.json package-lock.json* ./
# Install full deps for any future build steps; we'll prune in the runner.
RUN --mount=type=cache,target=/root/.npm \
    npm ci --no-audit --no-fund

# ---- Runtime stage ------------------------------------------------------
FROM node:${NODE_VERSION}-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production \
    PORT=5000 \
    NPM_CONFIG_LOGLEVEL=warn

# Drop privileges.
RUN addgroup -S app && adduser -S app -G app

COPY --from=deps /app/node_modules ./node_modules
COPY --chown=app:app . .

# Prune dev deps now that everything is copied.
RUN npm prune --omit=dev && rm -rf /root/.npm /tmp/* /var/cache/apk/*

USER app

EXPOSE 5000

# Lightweight container-level health probe; Fly.io has its own at the
# tcp/http level (configured in fly.toml).
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://localhost:${PORT}/api/status || exit 1

CMD ["node", "server.js"]

# syntax=docker/dockerfile:1

# Debian rather than Alpine on purpose: better-sqlite3 ships prebuilt binaries
# for glibc, and musl would force a source build on every deploy.
FROM node:22-bookworm-slim AS deps
WORKDIR /app

# Toolchain for the native SQLite module, in case no prebuild matches this
# platform. It lives in a stage that gets thrown away, so the final image stays
# slim — but its absence is the classic "works locally, fails on the VPS".
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# A second, complete install so TypeScript is available to compile with.
FROM deps AS build
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

# curl is only here for the healthcheck below.
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl \
  && rm -rf /var/lib/apt/lists/*

COPY --from=deps  /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY bin ./bin

# The ledger holds the Slack message mapping every existing thread depends on,
# so it must live on a mounted volume, never in the container layer.
ENV DB_PATH=/data/relay.db
RUN mkdir -p /data && chown -R node:node /data /app
VOLUME ["/data"]

USER node
EXPOSE 3737

# Relay reaches Slack over an outbound socket, so an unreachable API is the only
# thing worth probing from outside.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://127.0.0.1:3737/health || exit 1

CMD ["node", "dist/index.js"]

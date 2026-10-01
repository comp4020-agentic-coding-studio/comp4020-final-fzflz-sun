# syntax = docker/dockerfile:1

# The game in production: one Node process (server/index.ts) serving the
# Vite-built client from dist/, the save API, and README.md at /readme/.
# It listens on 0.0.0.0:$PORT (fly.toml sets 8080) and keeps its SQLite file
# on the /data volume, the only storage that survives a restart or redeploy.
# Node 24 runs the server's TypeScript directly (type stripping), so there is
# no server build step; only the client is bundled.

ARG NODE_VERSION=24.21.0
ARG PNPM_VERSION=11.9.0

FROM docker.io/library/node:${NODE_VERSION}-slim AS base
ARG PNPM_VERSION
RUN npm install -g pnpm@${PNPM_VERSION} && npm cache clean --force
WORKDIR /app

# full install + client build
FROM base AS build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY index.html vite.config.ts* tsconfig.json ./
COPY src ./src
RUN pnpm build

# runtime dependencies only (marked)
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --prod --frozen-lockfile

FROM docker.io/library/node:${NODE_VERSION}-slim
ENV NODE_ENV=production PORT=8080 DATA_DIR=/data
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json README.md ./
COPY docs ./docs
COPY server ./server
# the server validates saves with the same rules the client uses
COPY src/save.ts src/world.ts ./src/
RUN mkdir -p /data
EXPOSE 8080
CMD ["node", "--disable-warning=ExperimentalWarning", "server/index.ts"]

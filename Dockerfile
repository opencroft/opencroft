# syntax=docker/dockerfile:1.7

# --- Build ---
FROM node:24-slim AS build
WORKDIR /repo

# Install all workspaces from the root lockfile. Copy the root manifest + every
# workspace manifest first so the install layer caches independently of source.
COPY package.json package-lock.json ./
COPY apps/opencroft/package.json ./apps/opencroft/package.json
COPY packages/ui-kit/package.json ./packages/ui-kit/package.json
RUN --mount=type=cache,target=/root/.npm npm ci

COPY . .

# Create the schema in a fresh DB at build time (drizzle-kit push, non-interactive);
# this empty DB is baked into seed.db below for new installs.
RUN mkdir -p apps/opencroft/data && npm run push -w @opencroft/db

WORKDIR /repo/apps/opencroft
RUN npm run build

# --- Runtime ---
# The app is flattened into /app: the Nitro output, runtime deps, and the source
# the extension compiler needs all live there, with /app as the working directory
# so process.cwd()-relative paths (data/, .cache, extensions) resolve.
FROM node:24-slim AS runtime
WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends openssh-client git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV PORT=9999
ENV HOST=0.0.0.0
ENV HOSTNAME=0.0.0.0
ENV OPENCROFT_CACHE_DIR=/home/node/.cache

# Nitro build output: the self-contained Node server (.output/server, incl. the
# /api/ws/terminal WebSocket route) plus the public client assets (.output/public).
COPY --from=build --chown=node:node /repo/apps/opencroft/.output ./.output
# Runtime deps are hoisted to the workspace root by npm; copy them next to the
# app so Node resolves them from /app/node_modules. The Start server build,
# drizzle-orm / better-sqlite3, esbuild (runtime extension compile), ssh2 / node-pty / ws live here.
COPY --from=build --chown=node:node /repo/node_modules ./node_modules
# Workspace package sources. node_modules/<pkg> are relative symlinks into
# ../packages (e.g. agent-client, which ships raw TS and is imported by the
# builtin core extension). The runtime extension compiler resolves these from
# /app/node_modules, so the real source must exist at /app/packages or the
# symlinks dangle and core fails to build.
COPY --from=build --chown=node:node /repo/packages ./packages
COPY --from=build --chown=node:node /repo/apps/opencroft/package.json ./package.json
# Source is needed at runtime by the extension compiler (builtin extension lives in app/).
COPY --from=build --chown=node:node /repo/apps/opencroft/app ./app
COPY --from=build --chown=node:node /repo/apps/opencroft/data/opencroft.db ./seed.db

USER node
EXPOSE 9999
CMD ["node", ".output/server/index.mjs"]

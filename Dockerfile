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

WORKDIR /repo/apps/opencroft
RUN npx prisma generate
RUN mkdir -p data && npx prisma db push
RUN npm run build

# --- Runtime ---
# The app is flattened into /app: dist, runtime deps, and the source the
# extension compiler needs all live there, with /app as the working directory
# so process.cwd()-relative paths (data/, .cache, extensions) resolve.
FROM node:24-slim AS runtime
WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends openssh-client git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV PORT=9999
ENV HOSTNAME=0.0.0.0
ENV OPENCROFT_CACHE_DIR=/home/node/.cache

# App build output + the Node prod entry (HTTP + static + WebSocket terminal).
COPY --from=build --chown=node:node /repo/apps/opencroft/dist ./dist
# Runtime deps are hoisted to the workspace root by npm; copy them next to the
# app so Node resolves them from /app/node_modules. The Start server build,
# prisma client, esbuild (runtime extension compile), ssh2 / node-pty / ws live here.
COPY --from=build --chown=node:node /repo/node_modules ./node_modules
COPY --from=build --chown=node:node /repo/apps/opencroft/package.json ./package.json
COPY --from=build --chown=node:node /repo/apps/opencroft/prisma ./prisma
COPY --from=build --chown=node:node /repo/apps/opencroft/prisma.config.ts ./prisma.config.ts
# Source is needed at runtime by the extension compiler (builtin extension lives in app/).
COPY --from=build --chown=node:node /repo/apps/opencroft/app ./app
COPY --from=build --chown=node:node /repo/apps/opencroft/data/opencroft.db ./seed.db

USER node
EXPOSE 9999
CMD ["node", "dist/prod.mjs"]

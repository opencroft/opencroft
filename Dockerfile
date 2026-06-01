# syntax=docker/dockerfile:1.7

# --- Build ---
FROM node:24-slim AS build
WORKDIR /app

COPY package.json package-lock.json ./
COPY scripts ./scripts
RUN --mount=type=cache,target=/root/.npm npm ci

COPY . .
RUN npx prisma generate
RUN mkdir -p data && npx prisma db push
RUN npm run build

# --- Runtime ---
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
COPY --from=build --chown=node:node /app/dist ./dist
# Runtime deps: the Start server build, prisma client, esbuild (runtime extension
# compile), ssh2 / node-pty / ws (terminal), and extension dependencies all live here.
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/prisma ./prisma
COPY --from=build --chown=node:node /app/prisma.config.ts ./prisma.config.ts
# Source is needed at runtime by the extension compiler (builtin extension lives in app/).
COPY --from=build --chown=node:node /app/app ./app
COPY --from=build --chown=node:node /app/data/opencroft.db ./seed.db

USER node
EXPOSE 9999
CMD ["node", "dist/prod.mjs"]

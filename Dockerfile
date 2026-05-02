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
RUN --mount=type=cache,target=/app/.next/cache npm run build
RUN node scripts/collect-extension-deps.mjs extension-deps

# --- Runtime ---
FROM node:24-slim AS runtime
WORKDIR /app

RUN apt-get update \
 && apt-get install -y --no-install-recommends openssh-client git \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=9999
ENV HOSTNAME=0.0.0.0

COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/public ./public
COPY --from=build --chown=node:node /app/prisma ./prisma
COPY --from=build --chown=node:node /app/extension-deps ./node_modules

USER node
EXPOSE 9999
CMD ["node", "server.js"]

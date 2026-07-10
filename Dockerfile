# --- Build stage ---
FROM node:20-slim AS build

RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY shared/ shared/
COPY server/ server/
COPY web/ web/

RUN pnpm install --frozen-lockfile
RUN pnpm build

# Prune dev dependencies
RUN pnpm prune --prod

# --- Runtime stage ---
FROM node:20-slim

RUN apt-get update && apt-get install -y tini && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=build /app/package.json /app/pnpm-workspace.yaml ./
COPY --from=build /app/node_modules/ node_modules/
COPY --from=build /app/shared/dist/ shared/dist/
COPY --from=build /app/shared/package.json shared/
COPY --from=build /app/shared/node_modules/ shared/node_modules/
COPY --from=build /app/server/dist/ server/dist/
COPY --from=build /app/server/package.json server/
COPY --from=build /app/server/node_modules/ server/node_modules/
COPY --from=build /app/web/dist/ web/dist/

# node:20-slim ships a non-root `node` user (uid 1000) — run as that instead
# of root. Volume mount points must be owned by it before Docker seeds a
# fresh named volume from this layer.
RUN mkdir -p /data/config /data/recordings \
  && chown -R node:node /app /data/config /data/recordings

USER node

VOLUME ["/data/config", "/data/recordings"]

ENV APPLAUD_CONFIG_DIR=/data/config
ENV NODE_ENV=production

EXPOSE 44471

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:44471/api/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

ENTRYPOINT ["tini", "--"]
CMD ["node", "server/dist/index.js"]

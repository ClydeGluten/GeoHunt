# syntax=docker/dockerfile:1.7
FROM node:24-alpine AS build
RUN npm install --global pnpm@11.19.0
WORKDIR /workspace
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/api/package.json apps/api/package.json
COPY apps/bot/package.json apps/bot/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/game-engine/package.json packages/game-engine/package.json
RUN pnpm install --frozen-lockfile
COPY . .
ARG VITE_MAP_STYLE_URL=https://tiles.openfreemap.org/styles/liberty
ENV VITE_MAP_STYLE_URL=$VITE_MAP_STYLE_URL
RUN pnpm build
RUN pnpm --filter @geohunter/api deploy --prod /deploy/api
RUN pnpm --filter @geohunter/bot deploy --prod /deploy/bot
RUN pnpm --filter @geohunter/db deploy --prod /deploy/migrate

FROM node:24-alpine AS api
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /deploy/api/ ./
USER node
EXPOSE 3000
CMD ["node", "dist/server.js"]

FROM node:24-alpine AS bot
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /deploy/bot/ ./
USER node
EXPOSE 3001
CMD ["node", "dist/index.js"]

FROM node:24-alpine AS migrate
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /deploy/migrate/ ./
USER node
CMD ["node", "dist/migrate.js"]

FROM nginxinc/nginx-unprivileged:1.29-alpine AS web
COPY infra/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /workspace/apps/web/dist /usr/share/nginx/html
EXPOSE 8080

FROM cloudflare/cloudflared:latest AS cloudflared

FROM postgis/postgis:17-3.5-alpine AS all-in-one
RUN apk add --no-cache bash caddy curl nodejs-current redis \
  && addgroup -g 10001 -S geohunter \
  && adduser -u 10001 -S -D -H -G geohunter geohunter \
  && mkdir -p /opt/geohunter/api /opt/geohunter/bot /opt/geohunter/migrate /srv/geohunter/web /var/lib/redis /var/lib/caddy /var/log/geohunter /var/run/geohunter \
  && chown -R geohunter:geohunter /opt/geohunter /srv/geohunter /var/log/geohunter /var/run/geohunter \
  && chown -R redis:redis /var/lib/redis \
  && chown -R caddy:caddy /var/lib/caddy
COPY --from=cloudflared /usr/local/bin/cloudflared /usr/local/bin/cloudflared
COPY --from=build --chown=geohunter:geohunter /deploy/api/ /opt/geohunter/api/
COPY --from=build --chown=geohunter:geohunter /deploy/bot/ /opt/geohunter/bot/
COPY --from=build --chown=geohunter:geohunter /deploy/migrate/ /opt/geohunter/migrate/
COPY --from=build --chown=geohunter:geohunter /workspace/apps/web/dist/ /srv/geohunter/web/
COPY --chmod=755 infra/postgres/init/001-roles.sh /docker-entrypoint-initdb.d/001-roles.sh
COPY infra/all-in-one/Caddyfile /etc/caddy/Caddyfile
COPY --chmod=755 infra/all-in-one/entrypoint.sh /usr/local/bin/geohunter-entrypoint
COPY --chmod=755 infra/all-in-one/healthcheck.sh /usr/local/bin/geohunter-healthcheck
ENV NODE_ENV=production \
  PGDATA=/var/lib/postgresql/data \
  TUNNEL_MODE=quick
VOLUME ["/var/lib/postgresql/data", "/var/lib/redis", "/var/lib/caddy"]
EXPOSE 80 443 443/udp 5432
HEALTHCHECK --interval=20s --timeout=8s --start-period=90s --retries=5 CMD ["/usr/local/bin/geohunter-healthcheck"]
ENTRYPOINT ["/usr/local/bin/geohunter-entrypoint"]

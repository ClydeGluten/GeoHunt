# GeoHunter Zone

Mobile-first, server-authoritative hide-and-seek game for browsers and Telegram Mini Apps.

## Quick start

1. Copy `.env.example` to `.env` and replace every `replace-...` secret.
2. Run `docker compose up -d --build`.
3. Open `http://localhost`.

`localhost` is a browser secure context even over HTTP. Telegram and remote phone geolocation require HTTPS. Set `TUNNEL_MODE=quick` for an automatically configured temporary Cloudflare URL. The container updates Telegram whenever that URL changes after a restart.

## Local development

```powershell
pnpm install
pnpm build
pnpm test
pnpm dev
```

## Container

Compose runs one `geohunter` container. It supervises the React web app, Fastify/Socket.IO API, grammY bot, PostgreSQL/PostGIS, Redis, Caddy, migrations, and cloudflared. Persistent database, Redis, and certificate data remain in Docker volumes when the container is rebuilt.

View the current quick-tunnel URL with:

```powershell
docker compose exec app cat /var/run/geohunter/public-url
```

## Privacy warning

V1 records full player routes indefinitely. Host must disclose this before play. Match deletion removes participants, locations, events, and replay publication through database cascades.

## Documentation

- REST/OpenAPI: `/api/docs`
- API health: `/api/health`
- Deployment and backups: [docs/operations.md](docs/operations.md)
- Architecture and security boundaries: [docs/architecture.md](docs/architecture.md)
- Researched MCP servers and skills: [docs/development-tooling.md](docs/development-tooling.md)
- Verification matrix: [docs/testing.md](docs/testing.md)
- Age/minor policy remains V1 release blocker.

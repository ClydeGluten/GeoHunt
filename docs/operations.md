# Operations runbook

## Local start

1. Copy `.env.example` to `.env`.
2. Replace every database and service secret. `BOT_MODE=disabled` keeps the bot process idle; use `polling` with a real BotFather token for local bot work.
3. Run `docker compose up -d --build`.
4. Open `http://localhost`. The development host sign-in is available only while `NODE_ENV=development` and `DEV_AUTH_ENABLED=true`.

All components run in the single `geohunter` container. PostgreSQL is bound only to `127.0.0.1:5432`; Redis is never exposed to the host.

## Production checklist

- For a Cloudflare named tunnel, set `TUNNEL_MODE=named`, `CLOUDFLARED_TUNNEL_TOKEN`, `PUBLIC_WEBAPP_URL`, and `PUBLIC_BASE_URL`. For direct DNS, use `TUNNEL_MODE=disabled` and set `SITE_ADDRESS` to the domain; Caddy obtains and renews its certificate.
- Set `NODE_ENV=production`, `COOKIE_SECURE=true`, `DEV_AUTH_ENABLED=false`, and `BOT_MODE=webhook`.
- Generate distinct high-entropy values for the PostgreSQL roles, Redis, bot webhook, and bot-to-API service token. Never place `.env` in source control or an image.
- Supply a production map style/provider in `MAP_STYLE_URL`. Keep OSM attribution visible. Do not aim production traffic at `tile.openstreetmap.org`; its public service has no SLA and is not for heavy use.
- Restrict inbound traffic to ports 80/443. The database host binding is loopback-only; remove it entirely when development MCP access is unnecessary.
- Start with `docker compose up -d --build`, then verify `/api/health`, `/api/ready`, the web app, a Telegram Mini App launch, and a two-phone location exchange.
- Inspect `docker compose ps` and `docker compose logs app` after every deployment.

PostgreSQL, Redis, Caddy, the API, bot, web app, migration runner, and cloudflared are supervised inside one container. Application processes use dedicated unprivileged users; the container starts as root only to initialize storage and launch those processes.

## Backups

Location history is retained indefinitely, so the database volume is critical data. Run a daily logical backup and a provider-level encrypted volume snapshot. Keep at least one encrypted copy outside the server.

```powershell
./scripts/backup.ps1
```

The script produces a timestamped custom-format PostgreSQL archive under `backups/`. Encrypt and upload it according to the operator's retention policy. Backups contain precise routes and must be protected as sensitive personal data.

Create future replay partitions monthly:

```powershell
docker compose exec -T app psql -U postgres -d geohunter -c "SELECT ensure_location_sample_partitions(60);"
```

## Restore drill

Run this on a disposable deployment at least quarterly, and before relying on a new backup mechanism:

```powershell
./scripts/restore.ps1 -BackupFile ./backups/geohunter-YYYYMMDD-HHMMSS.dump
```

The restore script stops game writers, replaces the database contents, reruns the idempotent migration check, then starts the API and bot. This is destructive to the selected deployment; never point a drill at production.

After restore, verify row counts in `matches`, `participants`, `location_samples`, and `game_events`; open one published replay; then create and delete a disposable match.

## Deletion and export

Hosts can export `GET /api/v1/matches/:id/export` and permanently delete `DELETE /api/v1/matches/:id`. Deleting a match cascades through its playzone, participants, coordinates, events, sessions tied to guest participants, invites, boundary state, and replay publication. The operator must also expire that match from backup retention according to the privacy policy.

## Read-only PostgreSQL MCP

Use the `geohunter_mcp` credential only, through the loopback database port. It receives `SELECT` privileges and cannot modify runtime data. Keep MCP access out of production or connect through an audited tunnel. Revoke access immediately if an agent configuration is shared.

## Release blocker

Do not call V1 release-ready until age limits, guardian consent, location retention, replay sharing, safety reporting, deletion requests, and the privacy policy have explicit product/legal decisions.

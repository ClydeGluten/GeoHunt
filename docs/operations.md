# Operations runbook

## Fast browser-only evaluation

```bash
./scripts/judge-demo.sh
```

The launcher creates a mode-`0600` `.env.judge` with random local secrets, builds the all-in-one image, starts it, and waits for `http://127.0.0.1:8080/api/ready`. It sets `BOT_MODE=disabled`, so no Telegram credential is needed.

```bash
./scripts/judge-demo.sh status
./scripts/judge-demo.sh logs
./scripts/judge-demo.sh stop   # preserve volumes
./scripts/judge-demo.sh reset  # delete volumes and .env.judge
```

Default host bindings are:

- web/API: `http://localhost:8080`;
- HTTPS listener: `8443`;
- PostgreSQL: `127.0.0.1:55432`;
- Redis: not exposed.

Override the judge launcher's defaults with `GEOHUNT_JUDGE_WEB_PORT`, `GEOHUNT_JUDGE_HTTPS_PORT`, or `GEOHUNT_JUDGE_POSTGRES_PORT`. Run `reset` before changing them if `.env.judge` already exists. The judge launcher selects a separate Compose project and project-scoped volumes.

## Manual local start

1. Copy `.env.example` to `.env`.
2. Replace every database and service secret. `BOT_MODE=disabled` keeps the bot process idle; use `polling` with a real BotFather token for local bot work.
3. Run `docker compose up --detach --build`.
4. Open `http://localhost:8080` and use the normal browser trail-name flow.

`DEV_AUTH_ENABLED` controls only the synthetic developer-auth endpoint. Normal cookie-backed browser accounts work in production mode and do not require Telegram.

All components run in a single application container. PostgreSQL is loopback-bound for optional local inspection; remove that host mapping entirely in production.

## Production checklist

- For a Cloudflare named tunnel, set `TUNNEL_MODE=named`, `CLOUDFLARED_TUNNEL_TOKEN`, `PUBLIC_WEBAPP_URL`, and `PUBLIC_BASE_URL`. For direct DNS, use `TUNNEL_MODE=disabled`, point DNS at the host, and set `SITE_ADDRESS` to the domain so Caddy can obtain certificates.
- Set `NODE_ENV=production`, `COOKIE_SECURE=true`, `DEV_AUTH_ENABLED=false`, and either `BOT_MODE=webhook` or `BOT_MODE=disabled`.
- Generate distinct high-entropy values for PostgreSQL roles, Redis, webhook verification, and bot-to-API signing. Never put a real `.env` in source control or an image.
- Set an exact `CORS_ORIGIN` allowlist. Do not retain localhost origins on a public deployment.
- Supply a production map style/provider in `MAP_STYLE_URL`, verify its terms and capacity, and keep OpenStreetMap attribution visible.
- Restrict inbound traffic to required web ports. Do not expose PostgreSQL, Redis, or the internal bot API.
- Apply CPU, memory, disk, connection, and log-retention limits appropriate to the expected player count.
- Run `docker compose up --detach --build`, then verify `/api/health`, `/api/ready`, the web app, the selected bot mode, and a two-phone location exchange.
- Inspect `docker compose ps` and `docker compose logs app` after every deployment.
- Run the mobile journeys in [`testing.md`](testing.md).
- Publish an operator-specific privacy notice, retention period, contact route, and deletion/backups procedure.

PostgreSQL, Redis, Caddy, the API, bot health service, web app, migration runner, and optional cloudflared process run inside one container. Application processes use dedicated unprivileged users; the container starts as root only to initialize storage and launch them.

## Readiness and health

- `/api/health` confirms the API process responds.
- `/api/ready` verifies the API can reach PostgreSQL and Redis.
- The image health check also checks the internal web route, database, and Redis.

A health response is not a gameplay test. Always create, join, and delete a disposable match after a deployment or restore.

## Backups

The current release has no automatic location-retention policy, so the database volume and every backup can contain sensitive precise routes. Run a logical backup and encrypted provider-level snapshot on an operator-defined schedule. Keep at least one encrypted copy outside the server, with a tested expiry process.

On PowerShell hosts:

```powershell
./scripts/backup.ps1
```

The script writes a timestamped custom-format PostgreSQL archive under `backups/`. Encrypt it before transport. Do not commit the archive or place it in a shared unencrypted folder.

Create future replay partitions monthly:

```bash
docker compose exec -T app psql -U postgres -d geohunter \
  -c "SELECT ensure_location_sample_partitions(60);"
```

## Restore drill

Run a restore only on a disposable deployment until the target is verified. The operation replaces database contents.

```powershell
./scripts/restore.ps1 -BackupFile ./backups/geohunter-YYYYMMDD-HHMMSS.dump
```

After restore:

1. rerun the migration readiness check;
2. verify row counts in `matches`, `participants`, `location_samples`, and `game_events`;
3. open one authorized replay;
4. create and delete a disposable match;
5. confirm that expired/deleted live records are not unintentionally resurrected by the backup policy.

## Deletion and export

- Host JSON export: `GET /api/v1/matches/:id/export`
- Host match deletion: `DELETE /api/v1/matches/:id`
- Current identity deletion: `DELETE /api/v1/account`

Match deletion cascades through playzone, settings, participants, coordinates, events, guest sessions, invites, boundary state, and replay publication. Account deletion also removes every match hosted by that account and the account's participation in other matches. Guest identity deletion removes that participant and its cascaded location history.

The replay/export response is capped at 10,000 frames and 10,000 events and reports truncation. It is not a complete bulk-export API for larger matches yet.

Deletion from the live database does not erase external logs, already-downloaded exports, published screenshots, or backups. Operators must include those systems in their policy.

## Read-only PostgreSQL MCP

Use only the `geohunter_mcp` credential through a loopback or audited tunnel. The role receives `SELECT` privileges and cannot modify runtime data. Keep MCP access out of production unless there is an explicit operational need, and revoke the credential if an agent configuration is exposed.

## Remaining public-release blockers

Do not present the current build as suitable for games involving minors until age limits, guardian consent, and safety escalation have explicit product and legal decisions. Before an internet-facing launch, also choose a retention period, implement replay pagination, select a repository license, and complete jurisdiction-specific privacy review.

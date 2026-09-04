# Architecture

## Runtime flow

```text
Mobile browser / Telegram Mini App
        │ HTTPS + session cookie
        ▼
      Caddy
       ├── React/MapLibre PWA
       ├── Fastify REST + Socket.IO
       └── grammY webhook
                │
        ┌───────┴────────┐
        ▼                ▼
 PostgreSQL/PostGIS     Redis
 source of truth        presence, locks,
 routes and events      fanout, cooldowns
```

The server owns match state, timers, accepted locations, boundary decisions, tags, wins, replay access, and visibility filtering. A client never receives an unauthorized current coordinate. Frozen markers are copied from that observer's last authorized reveal cache.

PostgreSQL timestamps allow state recovery after API restarts. Redis data is disposable: losing it temporarily removes presence/frozen-marker caches and transient dwell timers, but not match or replay history.

## Workspace

- `apps/web`: React 19/Vite PWA, MapLibre zone editor, geolocation, live game, replay.
- `apps/api`: Fastify REST/OpenAPI, Socket.IO rooms, Telegram/session security, authoritative orchestration.
- `apps/bot`: grammY commands, Mini App buttons, polling or secret-verified webhook.
- `packages/contracts`: Zod request, state, and realtime contracts.
- `packages/game-engine`: pure timer, reveal, movement, tag, and win rules.
- `packages/db`: Drizzle schema plus raw PostGIS migration and runner.

## Location and replay model

Every accepted update writes an immutable monthly-partitioned `location_samples` row and updates `latest_locations`. Points are `geography(Point,4326)` with GiST indexes. Playzones are valid `geometry(Polygon,4326)` polygons. Boundary checks use `ST_Covers`; final tag distance uses `ST_DWithin` and `ST_Distance`.

Rejected points are not stored as coordinates. The event log records their reason, sequence, and accuracy. Full replay coordinates have no automatic purge in V1.

## Security boundaries

- Telegram `initData` is HMAC-verified and age-limited on the server; `initDataUnsafe` is display-only.
- Hosts require a verified Telegram-backed account. Browser guest sessions can only join an invitation.
- Invitations are random and stored only as SHA-256 hashes. Rotating one revokes previous invitations.
- Cookies are HttpOnly. Production uses Secure/SameSite=None for Telegram's embedded web context.
- CORS and Socket.IO origins are allowlisted. State-changing inputs are Zod-validated and globally rate-limited.
- The bot uses a dedicated service secret. Telegram webhook requests also require Telegram's secret header.
- Runtime SQL, migrations, and optional MCP inspection use separate database roles.

## Known platform limits

Mobile browsers and Telegram Mini Apps cannot promise tracking while the phone is locked or the web view is backgrounded. The UI discloses that limit. GPS spoofing cannot be eliminated in a web app; V1 only detects stale, inaccurate, duplicated, clock-skewed, and implausibly fast samples.

# Architecture

## Runtime flow

```text
Browser / Telegram Mini App
        │ HTTPS + HttpOnly session cookie
        ▼
      Caddy
       ├── React + MapLibre PWA
       ├── Fastify REST + Socket.IO
       └── grammY webhook
                 │
          ┌──────┴─────────────┐
          ▼                    ▼
 PostgreSQL + PostGIS         Redis
 durable source of truth      presence, pulse state,
 transactions and replay      fan-out, dwell, rate limits
```

The server owns match state, timers, accepted locations, boundary decisions, tag validity, winners, replay access, and visibility filtering. A client does not receive every current coordinate and hide some locally. Frozen markers come from that observer's last authorized reveal cache.

PostgreSQL timestamps allow state recovery after API restarts. Redis state is operational and disposable: losing it removes presence, cached frozen markers, transient dwell state, and rate-limit counters, but not matches or replay history. State-changing realtime requests fail closed while their Redis-backed limiter is unavailable.

## Workspace

- `apps/web`: React 19/Vite PWA, browser and Telegram entry, MapLibre zone editor, geolocation, live game, replay.
- `apps/api`: Fastify REST/OpenAPI, Socket.IO rooms, session security, snapshot projection, persistence orchestration.
- `apps/bot`: grammY commands, signed web-app hand-off, polling or secret-verified webhook.
- `packages/contracts`: Zod request, match-state, and realtime contracts.
- `packages/game-engine`: pure timer, reveal, movement, tag, and winner rules.
- `packages/db`: Drizzle schema, raw PostGIS migrations, role grants, and migration runner.

## Identity model

GeoHunt supports three session kinds:

- `WEB`: random browser account with a user-chosen display name;
- `TELEGRAM`: account derived from server-validated Telegram Mini App init data;
- `GUEST`: one invited participant, without permission to host.

All use an opaque HttpOnly cookie. Only a SHA-256 hash of the cookie token is stored. Browser and Telegram accounts may host. A guest can only join an invitation. Replacing or revoking a guest session also retires its participant so an abandoned cookie cannot leave an active player behind.

Telegram chat linking is a separate authorization step. A bot-generated grant binds chat ID, Telegram user ID, and issue time under a service-token HMAC. The API checks the account binding, five-minute lifetime, and one-time Redis consumption before associating the chat with a match.

## Location and replay model

Every accepted update conditionally advances `latest_locations` and appends an immutable monthly-partitioned `location_samples` row in the same transaction. Both use `geography(Point,4326)` and spatial indexes. Playzones use valid `geometry(Polygon,4326)` polygons.

- Boundary checks use `ST_Covers`.
- Final tag validation uses current database positions, freshness and accuracy limits, `ST_DWithin`, and `ST_Distance` while the match row is locked.
- A lower or duplicate client sequence cannot change either latest state or history.
- Rejected points are not stored as coordinates. The event log retains reason, sequence, and accuracy.
- Replay responses are capped at 10,000 frames and 10,000 events and explicitly report truncation.

There is no automatic location purge in this release. Identity and match deletion cascade through live records; operators must separately expire backups.

## Transaction and concurrency model

Match lifecycle operations lock the match row before validating and changing state. The same lock orders role changes, timer transitions, tag attempts, moderation, boundary disqualification, and winner finalization.

A successful state transition and its audit event are committed together. `finishIfNoActiveHiders` uses a conditional update while the match lock is held, so concurrent eliminations cannot emit two wins. Tag cooldown is also checked from accepted tag events under that lock; Redis cooldown state is only an optimization.

Session replacement locks the previous session. Guest invite switching creates the new participant and session, retires the old participant, and checks the old match's winner in one transaction.

## Realtime authorization

Socket.IO authenticates the cookie during the handshake and resolves a match-specific viewer. The stored cookie token and session ID are rechecked before snapshots, location fan-out, and every mutating event. A revoked or replaced session is disconnected.

Incoming payloads are parsed with Zod before fields are accessed. Rate-limit failures and database rejections are contained and returned to the caller instead of escaping as unhandled promise rejections.

## Security boundaries

- Telegram `initData` is HMAC-verified and age-limited on the server; `initDataUnsafe` is display-only.
- Invitations are random and stored only as SHA-256 hashes. Rotating one revokes previous invitations.
- Cookies are HttpOnly. Public HTTPS deployments use `Secure`; SameSite is selected for the embedded Telegram context.
- CORS and Socket.IO origins are allowlisted.
- Zod validates HTTP and realtime inputs.
- Redis limits browser/Telegram authentication, guest joins, invite previews, match creation/joining, replay/export reads, and realtime event families.
- The bot uses a dedicated service secret. Telegram webhook requests also require Telegram's secret header.
- Runtime SQL, migrations, and optional MCP inspection use different database roles.
- Public snapshots explicitly omit account IDs.

## Known platform limits

Mobile browsers and Telegram Mini Apps cannot guarantee tracking while the phone is locked or the web view is backgrounded. The UI discloses that limit. GPS spoofing cannot be eliminated in a web app; the current release detects stale, inaccurate, duplicated, clock-skewed, and implausibly fast samples but is not an anti-cheat guarantee.

See [`../PRIVACY.md`](../PRIVACY.md) for data handling and [`implementation-report.md`](implementation-report.md) for evidence tied to tests and source files.

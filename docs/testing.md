# Verification matrix

## Automated now

- `pnpm typecheck`: strict TypeScript across contracts, database, engine, API, bot, and web.
- `pnpm test`: fake-time visibility/state, movement and tag rules, plus Telegram signature/freshness security.
- `pnpm build`: all server artifacts and the production PWA bundle.
- `docker compose --env-file .env.example config --quiet`: validates the single-service deployment definition.
- `pnpm test:integration`: PostGIS edge/within-distance checks when `TEST_DATABASE_URL` points at a migrated disposable database.
- `pnpm test:load`: 100 Socket.IO clients, five-second location cadence, reconnects, and reveal churn against a prepared test match.

## Release-gate manual journeys

1. Android Chrome and Telegram: join, grant/deny/recover GPS, background/foreground, reconnect, tag, boundary grace, replay.
2. iOS Safari and Telegram: the same journey; explicitly check locked-screen behavior messaging and SameSite/Secure session continuity.
3. Two hiders, one seeker, and host: alternating reveal offsets, frozen marker age, pause/resume, emergency notification, auto tag, tap tag, timeout and all-hiders-caught endings.
4. Authorization: inspect network traffic as every role; no hidden current coordinate or unpublished replay may appear in any response.
5. Empty-volume Compose start, API restart during ACTIVE, encrypted backup, isolated restore, replay comparison, and permanent delete.

Run load tests only against disposable data. Simulated GPS points must stay inside the selected playzone unless the scenario is explicitly testing boundary behavior.

# Verification matrix

GeoHunt uses layered checks because pure game rules, database transactions, realtime authorization, and mobile browser behavior fail in different ways.

## Automated gates

| Command                                                 | Coverage                                                                                                                                   |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm test`                                             | Vitest across contracts, game engine, API security/routes/realtime/snapshots/store, bot helpers/actions/config, and web helpers/components |
| `pnpm test:integration`                                 | PostGIS geometry edge and distance behavior against `TEST_DATABASE_URL`                                                                    |
| `pnpm lint`                                             | Workspace TypeScript/lint gates                                                                                                            |
| `pnpm typecheck`                                        | Strict TypeScript across contracts, database, engine, API, bot, and web                                                                    |
| `pnpm build`                                            | Server artifacts and production PWA bundle                                                                                                 |
| `pnpm format:check`                                     | Repository formatting, excluding attributed vendored agent references                                                                      |
| `pnpm test:e2e`                                         | Playwright core lifecycle and multi-client scenarios against a running stack                                                               |
| `pnpm test:load`                                        | Socket.IO clients sending locations, reconnecting, and exercising reveal churn against disposable data                                     |
| `docker compose --env-file .env.example config --quiet` | Compose interpolation and deployment-definition validation                                                                                 |
| `bash -n scripts/judge-demo.sh`                         | Judge-launcher shell syntax                                                                                                                |

`apps/api/src/store.integration.test.ts` runs as part of `pnpm test` when `TEST_DATABASE_URL` is defined and skips cleanly when it is not. The GitHub Actions workflow provisions PostgreSQL/PostGIS, migrates it, and supplies that variable, so the transaction suite cannot silently disappear in CI.

## Database-backed integrity cases

The store suite checks, among other behavior:

- one seeker win after concurrent final-hider eliminations;
- moderation, GPS, boundary, guest-departure, and timeout winner paths;
- no winner when the opposite active role no longer exists;
- guest session replacement and revocation without ghost participants;
- account deletion cascades;
- role and timer rollback when audit-event insertion fails;
- role changes rejected after start;
- hider victory when a tag arrives after the deadline;
- authoritative position/distance and cooldown enforcement during a tag;
- transactional latest/history location persistence and monotonic client sequences;
- replay response caps.

These are real PostgreSQL/PostGIS operations, not mocked query snapshots.

## Fresh local database

Use a disposable migrated database. Never point destructive integration tests at production.

```bash
export DATABASE_URL='postgres://postgres:postgres@127.0.0.1:5432/geohunter_test'
export TEST_DATABASE_URL="$DATABASE_URL"
pnpm --filter @geohunter/db migrate
pnpm test
pnpm test:integration
```

The example credential is only for a disposable local test service.

## Judge container smoke test

```bash
./scripts/judge-demo.sh
curl --fail http://127.0.0.1:8080/api/ready
./scripts/judge-demo.sh status
```

Then verify in the browser:

1. Enter with a browser trail name; no Telegram session should be required.
2. Create a match, draw and edit a polygon, and review both consent controls.
3. Open the invitation in a private browser profile and review participant consent.
4. Assign at least one hider and one seeker.
5. Compare role-specific snapshots in two clients.
6. Pause, resume, trigger and end an emergency reveal, and finish the match.
7. Open the replay and exercise publication controls as the host.
8. Open `/api/docs` and `/api/ready`.
9. Delete a disposable participant identity and a disposable hosted match.

Clean up with `./scripts/judge-demo.sh reset`.

## Mobile release journeys

Before calling a public deployment ready, run these on actual devices:

1. Android Chrome and Telegram: join, grant/deny/recover GPS, background/foreground, reconnect, tag, boundary grace, replay.
2. iOS Safari and Telegram: the same journey, with explicit locked-screen messaging and Secure/SameSite cookie continuity.
3. Two hiders, one seeker, and a host: alternating reveal offsets, frozen-marker age, pause/resume, emergency notification, automatic and tap tags, timeout, and all-hiders-caught endings.
4. Authorization inspection: capture network traffic as every role; no hidden current coordinate, account ID, or unpublished replay may appear in an unauthorized response.
5. Empty-volume Compose start, API restart during `ACTIVE`, encrypted backup, isolated restore, replay comparison, and permanent deletion.

## Secret and publication checks

The release audit scans both the candidate tree and Git history with a checksum-verified Gitleaks binary. It also checks tracked filenames for environment files, keys, certificates, logs, generated build state, and private debug attachments.

A zero-finding scanner run means no configured pattern matched. It does not replace manual review, credential rotation, or a provider-side secret audit.

## What is not claimed

- Browser tests do not prove locked-screen tracking on every phone.
- Moderate multi-client tests are not internet-scale capacity certification.
- GPS validation is not a guarantee against spoofing.
- The current replay cap prevents unbounded responses but is not pagination.

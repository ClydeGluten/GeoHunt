# GeoHunt implementation report

**Contest candidate:** 2026-09-04  
**Comparison baseline:** `7a3445aa9e9ede55ae39e4b817abc6a461190c31`  
**Product name in the UI:** GeoHunter Zone

This report separates demonstrable repository work from product copy. Every substantial statement points to code, migrations, tests, or a reproducible command.

## Executive summary

The contest candidate turns the original Telegram-oriented prototype into a browser-first, server-authoritative location game with an optional Telegram integration. The largest additions are:

- browser account and guest-session flows;
- an interactive MapLibre playzone editor;
- per-viewer realtime snapshots and reconnect behavior;
- transactional match, session, role, timer, tag, and deletion logic;
- explicit location/replay consent and user-controlled data deletion;
- fresh PostgreSQL migrations for browser accounts and sessions;
- a one-command browser-only container launch;
- expanded unit, route, database-integration, and browser test coverage;
- public-history, generated-artifact, secret, and vendored-reference hygiene.

The implementation is a TypeScript monorepo, not a static contest mock. The browser, API, realtime gateway, bot, shared contracts, domain engine, migrations, PostGIS queries, Redis coordination, and deployment files are all present in this repository.

## Quantified change from the baseline

The following numbers were generated with Pygount 3.2.0 against the Git baseline and the contest working tree. Both scans excluded `.agents`, `.git`, `node_modules`, `dist`, `.turbo`, Playwright output, and test-result output.

| Measure                        | Baseline | Contest candidate |           Change |
| ------------------------------ | -------: | ----------------: | ---------------: |
| Counted code lines             |    3,974 |             7,882 |  +3,908 (+98.3%) |
| Production-oriented code lines |    3,352 |             5,946 |  +2,594 (+77.4%) |
| Test code lines                |      318 |             1,577 | +1,259 (+395.9%) |
| Test files                     |        6 |                21 |              +15 |
| Counted files                  |       77 |               104 |              +27 |

“Production-oriented” excludes Markdown, JSON, YAML, XML, and files classified as tests. These counts measure source volume, not quality; the invariant tests and executable judge path below provide the behavioral evidence.

### Reproduce the measurement

```bash
python -m venv /tmp/geohunt-metrics
/tmp/geohunt-metrics/bin/pip install pygount==3.2.0
/tmp/geohunt-metrics/bin/pygount \
  --folders-to-skip='node_modules,.git,dist,.turbo,playwright-report,test-results,.agents' \
  --format=json --out=/tmp/geohunt-current.json .

tmpdir="$(mktemp -d)"
git archive 7a3445aa9e9ede55ae39e4b817abc6a461190c31 | tar -x -C "$tmpdir"
/tmp/geohunt-metrics/bin/pygount \
  --folders-to-skip='node_modules,.git,dist,.turbo,playwright-report,test-results,.agents' \
  --format=json --out=/tmp/geohunt-baseline.json "$tmpdir"
```

## Delivered systems and evidence

### 1. Browser-first identity without weakening Telegram auth

**What changed**

- Added browser accounts and opaque cookie sessions.
- Added guest sessions tied to one invited participant.
- Kept Telegram init-data validation for Mini App users.
- Bound Telegram chat grants to chat ID, Telegram user ID, and issue time; grants expire and can be consumed once.
- Replaced an existing session and retired an old guest participant in the same database operation.
- Added explicit sign-out and identity deletion.

**Evidence**

- Routes and authorization: [`apps/api/src/routes.ts`](../apps/api/src/routes.ts)
- Token/init-data/chat-grant validation: [`apps/api/src/security.ts`](../apps/api/src/security.ts)
- Session and identity transactions: [`apps/api/src/store.ts`](../apps/api/src/store.ts)
- Browser UI: [`apps/web/src/BrowserLogin.tsx`](../apps/web/src/BrowserLogin.tsx), [`apps/web/src/auth.ts`](../apps/web/src/auth.ts)
- Telegram hand-off: [`apps/bot/src/chat-link.ts`](../apps/bot/src/chat-link.ts)
- Migrations: [`packages/db/migrations/0002_web_accounts.sql`](../packages/db/migrations/0002_web_accounts.sql), [`packages/db/migrations/0003_web_sessions.sql`](../packages/db/migrations/0003_web_sessions.sql)
- Tests: [`apps/api/src/routes.test.ts`](../apps/api/src/routes.test.ts), [`apps/api/src/security.test.ts`](../apps/api/src/security.test.ts), [`apps/bot/src/chat-link.test.ts`](../apps/bot/src/chat-link.test.ts)

### 2. Spatial game creation instead of coordinate forms

**What changed**

- Added a MapLibre polygon editor with corner creation, draggable handles, clearing, and automatic fit bounds.
- Added a two-step creation flow for geometry and game rules.
- Persisted the playzone as PostGIS geometry.

**Evidence**

- Map editor: [`apps/web/src/MapView.tsx`](../apps/web/src/MapView.tsx)
- Bounds calculation: [`apps/web/src/map-bounds.ts`](../apps/web/src/map-bounds.ts)
- Creation UI: [`apps/web/src/screens/CreateScreen.tsx`](../apps/web/src/screens/CreateScreen.tsx)
- Database geometry: [`packages/db/src/schema.ts`](../packages/db/src/schema.ts)
- Tests: [`apps/web/src/map-bounds.test.ts`](../apps/web/src/map-bounds.test.ts), [`apps/web/src/screens/CreateScreen.test.ts`](../apps/web/src/screens/CreateScreen.test.ts)

### 3. Server-authoritative realtime visibility

**What changed**

- Added typed Socket.IO contracts for location, presence, status, snapshots, tags, and match events.
- Built viewer-specific snapshots rather than broadcasting a complete world state.
- Added visibility pulses, frozen last-seen locations, stale markers, emergency reveal, and reconnect snapshots.
- Revalidate the cookie session after socket connection and disconnect revoked sessions.
- Validate payload shapes before property access and contain rejected async handlers.

**Evidence**

- Contracts: [`packages/contracts/src/index.ts`](../packages/contracts/src/index.ts)
- Snapshot projection: [`apps/api/src/snapshot.ts`](../apps/api/src/snapshot.ts)
- Realtime gateway: [`apps/api/src/realtime.ts`](../apps/api/src/realtime.ts)
- Domain visibility rules: [`packages/game-engine/src/index.ts`](../packages/game-engine/src/index.ts)
- Tests: [`apps/api/src/snapshot.test.ts`](../apps/api/src/snapshot.test.ts), [`apps/api/src/realtime.test.ts`](../apps/api/src/realtime.test.ts), [`packages/game-engine/src/index.test.ts`](../packages/game-engine/src/index.test.ts)

### 4. Transactional game integrity

The database is the final authority for state-changing operations. Important invariants now have database-backed tests:

| Invariant                                                           | Enforcement                                                                                      | Test evidence                                                          |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| A match finishes once when the final hider is removed concurrently  | Match row lock plus conditional finish update                                                    | `finishes exactly once when concurrent eliminations remove all hiders` |
| Role changes cannot race match start or leave an eventless change   | Match lock; role update and event share a transaction                                            | `rejects role changes after the match starts`; rollback fault test     |
| A late tag cannot beat the match deadline                           | Deadline checked under the match lock before target mutation                                     | `awards hiders when a tag arrives after the active deadline`           |
| A client cannot lie about tag distance                              | Current PostGIS points, accuracy, freshness, role, and status are re-read in the tag transaction | `rechecks authoritative positions before applying a tag`               |
| Concurrent tag attempts cannot bypass cooldown                      | Prior accepted tag event checked under the same match lock                                       | `enforces tag cooldown inside the tag transaction`                     |
| Timer state and timer event cannot diverge                          | Timer updates and events share one transaction                                                   | rollback fault test                                                    |
| Location history cannot advance behind the latest position          | Conditional monotonic upsert and history insert share one transaction                            | stale-sequence and rollback tests                                      |
| Replacing or revoking a guest session does not leave a ghost player | Session lock, participant retirement, winner check, and new session are atomic                   | replacement and revocation tests                                       |
| Account deletion removes hosted location history                    | Match/participant locks plus cascading deletes                                                   | identity-deletion integration test                                     |

The named cases are in [`apps/api/src/store.integration.test.ts`](../apps/api/src/store.integration.test.ts).

### 5. Privacy controls

**What changed**

- Hosts and invited players each see separate location and replay agreements.
- API contracts require affirmative values, so bypassing the checkbox in the browser does not bypass the rule.
- Public snapshots explicitly select safe participant fields and omit database account IDs.
- Account and guest deletion are exposed through the API and UI.
- Replay responses have per-request safety caps and return `truncated: true` when history is omitted.

**Evidence**

- Consent contracts: [`packages/contracts/src/index.ts`](../packages/contracts/src/index.ts)
- Consent screens: [`apps/web/src/screens/CreateScreen.tsx`](../apps/web/src/screens/CreateScreen.tsx), [`apps/web/src/screens/JoinScreen.tsx`](../apps/web/src/screens/JoinScreen.tsx)
- Deletion UI: [`apps/web/src/screens/Dashboard.tsx`](../apps/web/src/screens/Dashboard.tsx), [`apps/web/src/screens/GameScreen.tsx`](../apps/web/src/screens/GameScreen.tsx)
- Privacy behavior: [`PRIVACY.md`](../PRIVACY.md)

### 6. Reproducible deployment

**What changed**

- Added multi-stage targets for API, bot, migrations, web, and an all-in-one image.
- Added database-role bootstrap, migration startup, health checks, service supervision, Caddy routing, and optional Cloudflare tunneling.
- Added a judge launcher that generates local secrets and waits for `/api/ready`.
- Added a GitHub Actions gate backed by PostgreSQL/PostGIS.

**Evidence**

- Image: [`Dockerfile`](../Dockerfile)
- Stack: [`compose.yaml`](../compose.yaml)
- Startup and health: [`infra/all-in-one/entrypoint.sh`](../infra/all-in-one/entrypoint.sh), [`infra/all-in-one/healthcheck.sh`](../infra/all-in-one/healthcheck.sh)
- Judge launcher: [`scripts/judge-demo.sh`](../scripts/judge-demo.sh)
- CI: [`.github/workflows/verify.yml`](../.github/workflows/verify.yml)

## Originality and provenance boundary

### Product implementation

The runtime product is under `apps/`, `packages/`, `infra/`, and `tests/`. The custom behavior is visible in the game-state transitions, visibility policy, snapshot projection, PostGIS queries, concurrency control, browser/Telegram identity bridge, consent/deletion flow, and all-in-one deployment. Those files are ordinary reviewable source; no opaque hosted backend or prebuilt game service supplies the core behavior.

### Open-source dependencies

GeoHunt builds on libraries rather than reimplementing them: React, MapLibre GL JS, Fastify, Socket.IO, grammY, Zod, PostgreSQL/PostGIS, Redis, Caddy, Drizzle, Vitest, Playwright, and supporting packages. Dependency versions and transitive provenance are recorded in `package.json` files and [`pnpm-lock.yaml`](../pnpm-lock.yaml).

Map tiles and style are loaded from the configured provider. The default map displays OpenStreetMap attribution in the UI.

### Development references and AI-assisted workflow

The `.agents/` tree contains development-time MapLibre reference material. It is not imported or bundled at runtime. Its origin and local-adaptation boundary are declared in [`.agents/README.md`](../.agents/README.md), with retained [`LICENSE.md`](../.agents/LICENSE.md) and [`NOTICE`](../.agents/NOTICE).

Agent-assisted implementation was evaluated through source review, tests, fresh-database migration, container startup, and browser walkthroughs. The evidence is kept in the repository instead of treating generated code volume as proof of correctness.

## Judge walkthrough

1. Run `./scripts/judge-demo.sh`.
2. Open `http://localhost:8080` and enter a browser trail name.
3. Create a hunt and draw at least three map corners.
4. Review the rule surface and both host disclosures.
5. Open the generated invite in a private browser profile to exercise guest consent and identity isolation.
6. Assign one hider and one seeker, then start.
7. Compare the two clients: their snapshots and controls differ by role.
8. Finish the game and open the replay.
9. Inspect `/api/docs`, then compare the behavior with the source links above.
10. Run `./scripts/judge-demo.sh reset` when finished.

## Verification record

The final publication gate runs:

```bash
pnpm test
pnpm test:integration
pnpm lint
pnpm typecheck
pnpm build
pnpm format:check
git diff --check
```

A fresh PostgreSQL/PostGIS database is migrated before the database-backed suite. The browser judge flow is also exercised against a fresh all-in-one container. Exact results for this candidate are recorded in the commit message, the GitHub Actions run, and the final project handoff; they should not be inferred from source counts alone.

## Repository sanitation performed

- Removed three private debug screenshots containing approximate location context and expired tunnel URLs from public Git history.
- Verified the rewritten GitHub tree contains no `.codex-remote-attachments` paths.
- Scanned both the current candidate tree and Git history with checksum-verified Gitleaks 8.30.1; the scans completed without reported leaks at the audit point.
- Removed the tracked TypeScript incremental build artifact.
- Kept real product history and the project owner as the repository collaborator; sanitation did not replace authorship with a fabricated history.
- Added explicit notices around the only vendored development-reference tree.

A secret scanner is a detection layer, not proof that disclosure is impossible. Public deployment secrets still need rotation, least privilege, and operator review.

## Known limitations and honest boundaries

- Browser background geolocation is not guaranteed when a phone is locked.
- Replays are capped at 10,000 frames and 10,000 events per response. Pagination is not implemented yet.
- The replay UI does not render every historical role/status transition as an event-time snapshot.
- No automatic time-based location-retention job is included.
- The age/minor policy is not complete.
- The Cloudflare quick tunnel is temporary and changes on restart.
- The repository owner has not selected a project-wide open-source license.
- The current verification focuses on correctness and moderate multi-client behavior; it is not a claim of internet-scale load certification.

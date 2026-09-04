# GeoHunt update feed

Player-facing build notes for **GeoHunter Zone**. This file describes shipped repository behavior; deeper implementation evidence is in [`docs/implementation-report.md`](docs/implementation-report.md).

---

## Contest build — The Browser Hunt Update

**Released:** 2026-09-04  
**Version:** 0.1.0 contest candidate

GeoHunt is no longer tied to a Telegram-only entry flow. This update turns the prototype into a browser-first, self-hostable location game while keeping Telegram as an optional integration. It also moves the high-stakes decisions—visibility, tag validity, timers, winners, and location acceptance—behind transactional server checks.

### New: play from any browser

- Added cookie-backed browser identities with a simple trail-name entry screen.
- Added browser guest joins from invitation links. Each new invite creates one participant identity and one session in the same transaction.
- Kept Telegram Mini App authentication, bot controls, and deep links as an optional second entry path.
- Added short-lived, user-bound, one-use Telegram chat grants so a signed link cannot be reused by another Telegram account.
- Added a no-Telegram judge launcher: `./scripts/judge-demo.sh`.

### New: build the arena on the map

- Replaced coordinate entry with a MapLibre polygon editor.
- Tap to add corners, drag handles to refine the playzone, and clear or redraw without leaving the creation flow.
- Added automatic map fitting for the playzone and live positions.
- Kept OpenStreetMap attribution visible in the map UI.

### New: configurable hunt rules

Hosts can now configure:

- match and hiding-phase duration;
- tap tagging and automatic dwell tagging;
- tag radius and cooldown;
- caught-player behavior;
- location freshness, accuracy, and speed tolerances;
- boundary grace period, audience, and disqualification behavior;
- role-to-role visibility modes, including timed pulses and last-seen persistence.

A match cannot start without at least one active hider and one active seeker.

### New: role-specific live play

- Added Socket.IO snapshots projected separately for each viewer.
- Added presence heartbeats, reconnect snapshots, connection status, and stale-position indicators.
- Added hiding, active, paused, finished, and canceled match states.
- Added host role assignment, automatic team balancing, moderation, pause/resume, manual finish, and emergency reveal.
- Added hider/seeker win resolution for tags, moderation, boundary disqualification, guest departure, and timeouts.
- Added replay playback, host publication controls, participant access checks, and JSON export.

### Privacy and player control

- Split location recording and replay storage into two explicit agreements.
- Enforced both agreements in API contracts for hosts, account participants, and guests.
- Added **Sign out** and **Delete my data** controls.
- Account deletion removes participation data and every match hosted by that account.
- Guest deletion removes the guest participant, locations, and session.
- Added a plain-language [`PRIVACY.md`](PRIVACY.md) with collection, visibility, retention, deletion, operator, and safety details.
- Removed database account IDs from realtime snapshots.

### Security and integrity fixes

- Revalidate the backing cookie session after a socket connects; revoked or replaced sessions are disconnected.
- Validate all incoming realtime payloads before reading fields and contain rejected async handlers.
- Added Redis-backed limits for authentication, invitations, joining, match creation, replay, export, and realtime event families.
- Recheck tag state, deadline, roles, statuses, current database positions, accuracy, freshness, PostGIS distance, and cooldown inside the tag transaction.
- Resolve an expired active phase as a hider victory before a late tag can be applied.
- Serialize role changes with match start and write the role-change audit event atomically.
- Write timer transitions and their audit events in one transaction.
- Replace a prior cookie session and retire a guest participant atomically.
- Revoke guest sessions without leaving active ghost players in a match.
- Apply monotonically increasing location sequences with latest-position and history writes in one transaction.
- Cap one replay response at 10,000 frames and 10,000 events and flag truncated responses.

### Deployment and repository polish

- Added an all-in-one multi-stage image containing the web app, API, bot, PostGIS, Redis, Caddy, migrations, and optional Cloudflare tunnel support.
- Moved default host ports to `8080`, `8443`, and `55432` to reduce local conflicts.
- Added generated disposable secrets and readiness waiting to the judge launcher.
- Added a GitHub Actions verification workflow with PostgreSQL/PostGIS integration tests.
- Removed a tracked TypeScript incremental-build artifact.
- Removed private debug screenshots and expired tunnel URLs from public Git history while retaining product authorship commits.
- Added explicit provenance and MIT notices for vendored MapLibre development references under `.agents/`.
- Reworked the README around a one-command judge path, trust boundaries, architecture, custom technical scope, and direct source links.

### Test coverage added in this update

New checks cover:

- browser account and guest session replacement;
- Telegram proof binding, expiry, and grant shape;
- cross-account Telegram chat claims;
- malformed and rejected realtime work;
- revoked socket sessions;
- role-change and timer rollback on audit-event failure;
- concurrent final-hider elimination;
- late tags, authoritative tag distance, and cooldown;
- monotonic location sequences and transactional location persistence;
- snapshot privacy;
- account deletion cascades;
- replay response limits;
- browser login, invite consent, map bounds, client state derivation, bot configuration, and bot match actions.

### Known limitations

- Mobile browsers may suspend location updates while the screen is locked.
- Replay role/status presentation is based on the retained participant directory and event stream; the current UI does not yet render every historical role transition as a separate snapshot.
- Replays beyond the per-response 10,000-frame or 10,000-event safety cap need pagination before the omitted history can be viewed.
- No automatic time-based location-retention job is included; deletion is explicit.
- A complete age/minor policy is still required before games involving minors.
- A repository-wide open-source license has not yet been selected by the project owner.
- The temporary Cloudflare quick-tunnel URL changes on restart and is intended for evaluation, not a stable deployment.

---

## Prototype baseline

**Snapshot:** repository state before the contest upgrade

- Telegram-oriented entry path.
- Basic match creation and map-based gameplay foundations.
- Initial API, bot, game engine, PostGIS schema, Redis state, and container setup.
- No browser identity flow, judge launcher, update feed, implementation evidence report, deletion UI, or public-history sanitation.

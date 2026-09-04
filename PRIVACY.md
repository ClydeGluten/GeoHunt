# Privacy and location-data notice

GeoHunt is a self-hosted game that processes precise location data. Anyone deploying it becomes responsible for the data stored by that deployment. This document describes the behavior of the repository as shipped; it is not legal advice or a substitute for a policy appropriate to the operator's jurisdiction.

## What is collected

During a match, GeoHunt can store:

- account or guest display name and an internal random identifier;
- Telegram profile fields when the player chooses Telegram authentication;
- precise latitude and longitude samples;
- sample time, accuracy, speed, heading, source, and client sequence;
- role, status, connection presence, tag, boundary, moderation, and lifecycle events;
- the match polygon, settings, invitations, and replay-publication state.

Browser sessions are represented by opaque random cookies. Only hashes of those session tokens and invitation codes are stored in PostgreSQL.

## Why it is used

Location observations are used to validate the playzone, enforce GPS-quality settings, calculate server-side tag distance, project role-specific live positions, and build the post-match replay. Redis holds short-lived operational state such as presence, visibility pulses, cooldown hints, and rate limits.

## Consent flow

Consent is not implied by opening a link:

1. A host must separately confirm location recording and replay storage before creating a match.
2. Every invited participant must separately accept both disclosures before joining.
3. The API contracts require both affirmative values; omitting or sending `false` is rejected.

The UI warns that browser tracking may stop when a phone is locked and that the host can trigger an audited emergency reveal.

## Who can see location

Live visibility is calculated on the server for each viewer. A client does not receive every position and then hide some locally. Visibility depends on match state, viewer role, target role, configured pulse policy, stale-location rules, and emergency-reveal state.

The host can access a finished replay and JSON export. A host may publish a replay to the match's participants. Replay access is checked on each request and realtime sessions are revalidated after connection.

## Retention and deletion

The current release has no automatic time-based retention policy. Location history remains until the relevant identity or match is deleted by the deployment operator or user.

- **Delete my data** is available from the dashboard and in the in-game player panel.
- Deleting a guest identity removes its participant record and cascades its stored locations and session.
- Deleting an account removes its participation records and every match it hosts; match deletion cascades playzones, settings, invitations, locations, events, and replay publication.
- Hosts may also delete individual matches.
- **Sign out** revokes the current cookie. For a guest, revocation also marks the participant as having left.

Database backups can outlive live records. Operators must define backup retention and securely delete expired backups themselves.

## Data minimization and security controls

- Location and identity writes are tied to an authenticated participant or account.
- Telegram init data is authenticated, chat grants are user-bound, short-lived, and one-time, and internal bot calls use a separate service token.
- Accepted location updates advance monotonically by client sequence.
- Server-side tag application rechecks database positions, freshness, accuracy, distance, cooldown, state, deadline, role, and status in one transaction.
- REST authentication, match creation/joining, invite preview, replay, export, and realtime events are rate-limited through Redis.
- Public snapshots omit database account identifiers.
- Secrets belong in environment variables and are excluded from version control.

These controls reduce risk; they do not make a public location game inherently safe.

## Safety limits

Do not use GeoHunt for emergency response, covert tracking, workplace monitoring, or any situation where a location error can cause harm. Choose a legal, pedestrian-safe playzone away from roads, restricted property, hazards, and unwilling bystanders. Stop the game if a participant withdraws consent.

The repository does not yet provide a complete age-verification or minor-consent policy. Do not run games involving minors until the operator has supplied an appropriate policy and consent process.

## Operator checklist

Before a real deployment:

1. Use a stable HTTPS origin and unique high-entropy secrets.
2. Restrict access to PostgreSQL, Redis, backups, logs, and the host.
3. Publish operator identity, contact details, retention period, and jurisdiction-specific rights.
4. Set a deletion and backup-expiry process.
5. Explain emergency reveal and replay publication to every participant.
6. Test location permissions and locked-screen behavior on the actual devices.
7. Obtain informed consent outside the app as required by local law.

For system boundaries and threat assumptions, see [`docs/architecture.md`](docs/architecture.md). For backup and restore procedures, see [`docs/operations.md`](docs/operations.md).

import { createDatabase, type DatabaseConnection } from "@geohunter/db";
import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { GameStore } from "./store.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const connection = databaseUrl ? createDatabase(databaseUrl, { max: 2 }) : null;
const store = connection ? new GameStore(connection) : null;

function storeRejectingSql(fragment: string): GameStore {
  const wrap = (sql: any): any => {
    const tagged = (strings: TemplateStringsArray, ...values: unknown[]) => {
      if (strings.join(" ").includes(fragment)) {
        throw new Error("simulated database failure");
      }
      return sql(strings, ...values);
    };
    tagged.begin = (callback: (transaction: unknown) => unknown) =>
      sql.begin((transaction: unknown) => callback(wrap(transaction)));
    return tagged;
  };
  return new GameStore({ sql: wrap(connection!.sql) } as DatabaseConnection);
}

async function seedActiveMatch(
  options: {
    boundaryDisqualify?: boolean;
    secondHider?: boolean;
    state?: "LOBBY" | "HIDING" | "ACTIVE" | "PAUSED";
  } = {},
) {
  const accountId = randomUUID();
  const matchId = randomUUID();
  const hiderId = randomUUID();
  const seekerId = randomUUID();
  const secondHiderId = options.secondHider ? randomUUID() : null;
  await connection!.sql`
    insert into accounts (id, first_name) values (${accountId}, 'Host')
  `;
  await connection!.sql`
    insert into matches (id, host_account_id, name, state, phase_started_at, phase_ends_at, active_started_at)
    values (${matchId}, ${accountId}, 'Integration hunt', ${options.state ?? "ACTIVE"}, now(), now() + interval '1 hour', now())
  `;
  await connection!.sql`
    insert into match_settings (match_id, hide_seconds, boundary_grace_seconds, boundary_disqualify)
    values (${matchId}, 0, 0, ${options.boundaryDisqualify ?? false})
  `;
  await connection!.sql`
    insert into playzones (match_id, polygon)
    values (${matchId}, ST_GeomFromText('POLYGON((0 0,0 1,1 1,1 0,0 0))', 4326))
  `;
  await connection!.sql`
    insert into participants (id, match_id, display_name, role, status)
    values (${hiderId}, ${matchId}, 'Hider', 'HIDER', 'ACTIVE'),
           (${seekerId}, ${matchId}, 'Seeker', 'SEEKER', 'ACTIVE')
  `;
  if (secondHiderId)
    await connection!.sql`
      insert into participants (id, match_id, display_name, role, status)
      values (${secondHiderId}, ${matchId}, 'Second hider', 'HIDER', 'ACTIVE')
    `;
  return { accountId, matchId, hiderId, seekerId, secondHiderId };
}

async function seedInvite() {
  const accountId = randomUUID();
  const matchId = randomUUID();
  const inviteCode = `invite-${randomUUID()}`;
  const inviteHash = createHash("sha256").update(inviteCode).digest("hex");
  await connection!.sql`
    insert into accounts (id, first_name) values (${accountId}, 'Invite host')
  `;
  await connection!.sql`
    insert into matches (id, host_account_id, name, state)
    values (${matchId}, ${accountId}, 'Guest lobby', 'LOBBY')
  `;
  await connection!.sql`
    insert into match_settings (match_id) values (${matchId})
  `;
  await connection!.sql`
    insert into playzones (match_id, polygon)
    values (${matchId}, ST_GeomFromText('POLYGON((0 0,0 1,1 1,1 0,0 0))', 4326))
  `;
  await connection!.sql`
    insert into invitations (match_id, code_hash)
    values (${matchId}, ${inviteHash})
  `;
  return { matchId, inviteCode };
}

async function expectSeekerVictory(matchId: string) {
  const [match] = await connection!.sql<
    { state: string; winnerRole: string | null }[]
  >`select state, winner_role as "winnerRole" from matches where id=${matchId}`;
  const [events] = await connection!.sql<{ count: number }[]>`
    select count(*)::integer as count from game_events
    where match_id=${matchId} and type='MATCH_FINISHED'
  `;
  expect(match).toEqual({ state: "FINISHED", winnerRole: "SEEKER" });
  expect(events?.count).toBe(1);
}

describe.skipIf(!databaseUrl)("GameStore integrity", () => {
  beforeEach(async () => {
    await connection!.sql`delete from matches`;
    await connection!.sql`delete from accounts`;
  });

  afterAll(async () => {
    await connection?.close();
  });

  it("finishes with a seeker victory when moderation removes the final hider", async () => {
    const { matchId, hiderId } = await seedActiveMatch();

    await store!.moderateParticipant(matchId, hiderId, "DISQUALIFY");

    await expectSeekerVictory(matchId);
  });

  it("finishes with a seeker victory when GPS demotes the final hider", async () => {
    const { matchId, hiderId } = await seedActiveMatch();

    expect(await store!.forceSpectator(matchId, hiderId, "DENIED")).toBe(true);

    await expectSeekerVictory(matchId);
  });

  it("finishes exactly once when concurrent eliminations remove all hiders", async () => {
    const { matchId, hiderId, secondHiderId } = await seedActiveMatch({
      secondHider: true,
    });

    await Promise.all([
      store!.forceSpectator(matchId, hiderId, "DENIED"),
      store!.forceSpectator(matchId, secondHiderId!, "DENIED"),
    ]);

    await expectSeekerVictory(matchId);
  });

  it.each(["HIDING", "PAUSED"] as const)(
    "finishes when moderation removes the final hider during %s",
    async (state) => {
      const { matchId, hiderId } = await seedActiveMatch({ state });

      await store!.moderateParticipant(matchId, hiderId, "DISQUALIFY");

      await expectSeekerVictory(matchId);
    },
  );

  it("does not award seekers a victory when no active seeker remains", async () => {
    const { matchId, hiderId, seekerId } = await seedActiveMatch();

    await store!.moderateParticipant(matchId, seekerId, "SPECTATE");
    await store!.moderateParticipant(matchId, hiderId, "DISQUALIFY");

    const [match] = await connection!.sql<
      { state: string; winnerRole: string | null }[]
    >`select state, winner_role as "winnerRole" from matches where id=${matchId}`;
    const [events] = await connection!.sql<{ count: number }[]>`
      select count(*)::integer as count from game_events
      where match_id=${matchId} and type='MATCH_FINISHED'
    `;
    expect(match).toEqual({ state: "ACTIVE", winnerRole: null });
    expect(events?.count).toBe(0);
  });

  it("retires a guest final hider and finishes the match", async () => {
    const { matchId, hiderId } = await seedActiveMatch();
    const session = await store!.createSession({
      kind: "GUEST",
      participantId: hiderId,
      days: 1,
    });

    await store!.retireGuestIdentity(session.token, hiderId);

    await expectSeekerVictory(matchId);
  });

  it("retires a guest participant when its session is revoked", async () => {
    const { hiderId } = await seedActiveMatch({ secondHider: true });
    const session = await store!.createSession({
      kind: "GUEST",
      participantId: hiderId,
      days: 1,
    });

    await store!.revokeSession(session.token);

    expect(await store!.getSession(session.token)).toBeNull();
    const [participant] = await connection!.sql<{ status: string }[]>`
      select status from participants where id=${hiderId}
    `;
    expect(participant?.status).toBe("LEFT");
  });

  it("replaces a guest session and retires its participant atomically", async () => {
    const { hiderId } = await seedActiveMatch({ secondHider: true });
    const oldSession = await store!.createSession({
      kind: "GUEST",
      participantId: hiderId,
      days: 1,
    });
    const oldContext = await store!.getSession(oldSession.token);
    const accountId = randomUUID();
    await connection!.sql`
      insert into accounts (id, first_name) values (${accountId}, 'Browser host')
    `;

    const replacement = await store!.createSession(
      { kind: "WEB", accountId, days: 1 },
      { id: oldContext!.id, token: oldSession.token },
    );

    expect(await store!.getSession(oldSession.token)).toBeNull();
    expect((await store!.getSession(replacement.token))?.accountId).toBe(
      accountId,
    );
    const [participant] = await connection!.sql<{ status: string }[]>`
      select status from participants where id=${hiderId}
    `;
    expect(participant?.status).toBe("LEFT");
  });

  it("deletes an account together with its hosted location data", async () => {
    const { accountId, matchId, hiderId } = await seedActiveMatch();
    await store!.saveLocation(hiderId, {
      matchId,
      latitude: 0.5,
      longitude: 0.5,
      accuracyMeters: 5,
      speedMps: null,
      headingDegrees: null,
      recordedAt: new Date().toISOString(),
      clientSequence: 1,
      source: "BROWSER",
    });
    const created = await store!.createSession({
      kind: "WEB",
      accountId,
      days: 30,
    });
    const session = await store!.getSession(created.token);
    expect(session).not.toBeNull();

    await store!.deleteIdentity(session!);

    expect(await store!.getSession(created.token)).toBeNull();
    const [counts] = await connection!.sql<
      { accounts: number; matches: number; samples: number }[]
    >`
      select
        (select count(*)::integer from accounts where id=${accountId}) as accounts,
        (select count(*)::integer from matches where id=${matchId}) as matches,
        (select count(*)::integer from location_samples where match_id=${matchId}) as samples
    `;
    expect(counts).toEqual({ accounts: 0, matches: 0, samples: 0 });
  });

  it("joins a new guest and replaces the old guest in one store operation", async () => {
    const { hiderId } = await seedActiveMatch({ secondHider: true });
    const oldSession = await store!.createSession({
      kind: "GUEST",
      participantId: hiderId,
      days: 1,
    });
    const oldContext = await store!.getSession(oldSession.token);
    const { matchId, inviteCode } = await seedInvite();

    const joined = await store!.joinGuestSession(inviteCode, "New guest", 1, {
      id: oldContext!.id,
      token: oldSession.token,
    });

    expect(joined.matchId).toBe(matchId);
    expect((await store!.getSession(joined.token))?.participantId).toBe(
      joined.participantId,
    );
    expect(await store!.getSession(oldSession.token)).toBeNull();
    const [oldParticipant] = await connection!.sql<{ status: string }[]>`
      select status from participants where id=${hiderId}
    `;
    expect(oldParticipant?.status).toBe("LEFT");
  });

  it("rejects role changes after the match starts", async () => {
    const { matchId, hiderId, seekerId } = await seedActiveMatch({
      state: "LOBBY",
    });
    await store!.performAction(matchId, hiderId, "START");

    await expect(
      store!.assignRole(matchId, seekerId, "SPECTATOR"),
    ).rejects.toThrow();

    const [participant] = await connection!.sql<{ role: string }[]>`
      select role from participants where id=${seekerId}
    `;
    expect(participant?.role).toBe("SEEKER");
  });

  it("rolls back a role change when its audit event cannot be written", async () => {
    const { matchId, seekerId } = await seedActiveMatch({ state: "LOBBY" });
    const failingStore = storeRejectingSql("insert into game_events");

    await expect(
      failingStore.assignRole(matchId, seekerId, "SPECTATOR"),
    ).rejects.toThrow("simulated database failure");

    const [participant] = await connection!.sql<{ role: string }[]>`
      select role from participants where id=${seekerId}
    `;
    expect(participant?.role).toBe("SEEKER");
  });

  it("awards hiders when a tag arrives after the active deadline", async () => {
    const { matchId, hiderId, seekerId } = await seedActiveMatch();
    await connection!.sql`
      update matches set phase_ends_at=clock_timestamp() - interval '1 second'
      where id=${matchId}
    `;

    const result = await store!.applyTag(
      matchId,
      seekerId,
      hiderId,
      "SPECTATOR",
      1,
    );

    expect(result.applied).toBe(false);
    const [match] = await connection!.sql<
      { state: string; winnerRole: string | null }[]
    >`select state, winner_role as "winnerRole" from matches where id=${matchId}`;
    expect(match).toEqual({ state: "FINISHED", winnerRole: "HIDER" });
    const [hider] = await connection!.sql<{ role: string; status: string }[]>`
      select role, status from participants where id=${hiderId}
    `;
    expect(hider).toEqual({ role: "HIDER", status: "ACTIVE" });
  });

  it("rechecks authoritative positions before applying a tag", async () => {
    const { matchId, hiderId, seekerId } = await seedActiveMatch();
    const location = (
      participantId: string,
      coordinate: number,
      sequence: number,
    ) =>
      store!.saveLocation(participantId, {
        matchId,
        latitude: coordinate,
        longitude: coordinate,
        accuracyMeters: 5,
        speedMps: null,
        headingDegrees: null,
        recordedAt: new Date().toISOString(),
        clientSequence: sequence,
        source: "BROWSER",
      });
    await location(seekerId, 0.1, 1);
    await location(hiderId, 0.9, 1);

    const result = await store!.applyTag(
      matchId,
      seekerId,
      hiderId,
      "SPECTATOR",
      1,
    );

    expect(result.applied).toBe(false);
    const [hider] = await connection!.sql<{ role: string; status: string }[]>`
      select role, status from participants where id=${hiderId}
    `;
    expect(hider).toEqual({ role: "HIDER", status: "ACTIVE" });
  });

  it("enforces tag cooldown inside the tag transaction", async () => {
    const { matchId, hiderId, seekerId, secondHiderId } = await seedActiveMatch(
      { secondHider: true },
    );
    const recordedAt = new Date().toISOString();
    const saveNearbyLocation = (participantId: string) =>
      store!.saveLocation(participantId, {
        matchId,
        latitude: 0.5,
        longitude: 0.5,
        accuracyMeters: 5,
        speedMps: null,
        headingDegrees: null,
        recordedAt,
        clientSequence: 1,
        source: "BROWSER",
      });
    await saveNearbyLocation(seekerId);
    await saveNearbyLocation(hiderId);
    await saveNearbyLocation(secondHiderId!);

    const first = await store!.applyTag(
      matchId,
      seekerId,
      hiderId,
      "SPECTATOR",
      1,
    );
    const second = await store!.applyTag(
      matchId,
      seekerId,
      secondHiderId!,
      "SPECTATOR",
      1,
    );

    expect(first.applied).toBe(true);
    expect(second.applied).toBe(false);
    const [hider] = await connection!.sql<{ role: string; status: string }[]>`
      select role, status from participants where id=${secondHiderId}
    `;
    expect(hider).toEqual({ role: "HIDER", status: "ACTIVE" });
  });

  it("rejects a tag after the seeker is no longer active", async () => {
    const { matchId, hiderId, seekerId } = await seedActiveMatch();
    await store!.moderateParticipant(matchId, seekerId, "SPECTATE");

    const result = await store!.applyTag(
      matchId,
      seekerId,
      hiderId,
      "SPECTATOR",
      1,
    );

    expect(result).toEqual({ applied: false, finished: false });
    const [hider] = await connection!.sql<{ role: string; status: string }[]>`
      select role, status from participants where id=${hiderId}
    `;
    expect(hider).toEqual({ role: "HIDER", status: "ACTIVE" });
  });

  it("rolls back timer transitions when their audit event cannot be written", async () => {
    const { matchId } = await seedActiveMatch({ state: "HIDING" });
    await connection!.sql`
      update matches set phase_ends_at=now() - interval '1 second'
      where id=${matchId}
    `;
    const failingStore = storeRejectingSql("insert into game_events");

    await expect(failingStore.advanceTimers()).rejects.toThrow(
      "simulated database failure",
    );

    const [match] = await connection!.sql<{ state: string }[]>`
      select state from matches where id=${matchId}
    `;
    expect(match?.state).toBe("HIDING");
  });

  it("does not award hiders on timeout when no active hider remains", async () => {
    const { matchId, hiderId, seekerId } = await seedActiveMatch();
    await store!.moderateParticipant(matchId, seekerId, "SPECTATE");
    await store!.moderateParticipant(matchId, hiderId, "DISQUALIFY");
    await connection!.sql`
      update matches set phase_ends_at=now() - interval '1 second'
      where id=${matchId}
    `;

    await store!.advanceTimers();

    const [match] = await connection!.sql<
      { state: string; winnerRole: string | null }[]
    >`select state, winner_role as "winnerRole" from matches where id=${matchId}`;
    expect(match).toEqual({ state: "ACTIVE", winnerRole: null });
  });

  it("finishes with a seeker victory when the boundary disqualifies the final hider", async () => {
    const { matchId, hiderId } = await seedActiveMatch({
      boundaryDisqualify: true,
    });

    const result = await store!.saveLocation(hiderId, {
      matchId,
      latitude: 2,
      longitude: 2,
      accuracyMeters: 5,
      speedMps: null,
      headingDegrees: null,
      recordedAt: new Date().toISOString(),
      clientSequence: 1,
      source: "BROWSER",
    });

    expect(result?.disqualified).toBe(true);
    await expectSeekerVictory(matchId);
  });

  it("rolls back replay publication when its audit event cannot be written", async () => {
    const { accountId, matchId } = await seedActiveMatch();
    await connection!
      .sql`update matches set state='FINISHED', finished_at=now() where id=${matchId}`;
    const failingStore = storeRejectingSql("insert into game_events");

    await expect(
      failingStore.setReplayPublished(matchId, accountId, true),
    ).rejects.toThrow("simulated database failure");

    const [publication] = await connection!.sql<{ count: number }[]>`
      select count(*)::int as count from replay_publications where match_id=${matchId}
    `;
    expect(publication?.count).toBe(0);
  });

  it("does not expose replay history before a match finishes", async () => {
    const { matchId } = await seedActiveMatch();

    await expect(store!.getReplay(matchId)).rejects.toThrow(
      "Replay is available only after the match finishes",
    );
  });

  it("caps replay frames returned by one request", async () => {
    const { matchId, hiderId } = await seedActiveMatch();
    await connection!
      .sql`update matches set state='FINISHED', finished_at=now() where id=${matchId}`;
    await connection!.sql`
      insert into location_samples (
        match_id, participant_id, point, recorded_at, accuracy_meters,
        source, client_sequence
      )
      select ${matchId}, ${hiderId},
        ST_SetSRID(ST_MakePoint(0.5, 0.5), 4326)::geography,
        clock_timestamp() + (sample * interval '1 millisecond'),
        5, 'BROWSER', sample
      from generate_series(1, 10001) as sample
    `;

    const replay = await store!.getReplay(matchId);

    expect(replay.frames).toHaveLength(10_000);
    expect(replay.participants).not.toHaveLength(0);
    for (const participant of replay.participants) {
      expect(participant).not.toHaveProperty("accountId");
    }
  });

  it("rolls back location history when latest-position persistence fails", async () => {
    const { matchId, hiderId } = await seedActiveMatch();
    const failingStore = storeRejectingSql("insert into latest_locations");

    await expect(
      failingStore.saveLocation(hiderId, {
        matchId,
        latitude: 0.5,
        longitude: 0.5,
        accuracyMeters: 5,
        speedMps: null,
        headingDegrees: null,
        recordedAt: new Date().toISOString(),
        clientSequence: 1,
        source: "BROWSER",
      }),
    ).rejects.toThrow("simulated database failure");

    const [samples] = await connection!.sql<{ count: number }[]>`
      select count(*)::integer as count from location_samples
      where match_id=${matchId} and participant_id=${hiderId}
    `;
    expect(samples?.count).toBe(0);
  });

  it("does not record a stale client sequence", async () => {
    const { matchId, hiderId } = await seedActiveMatch();
    const base = {
      matchId,
      latitude: 0.5,
      longitude: 0.5,
      accuracyMeters: 5,
      speedMps: null,
      headingDegrees: null,
      recordedAt: new Date().toISOString(),
      source: "BROWSER" as const,
    };

    expect(
      await store!.saveLocation(hiderId, { ...base, clientSequence: 10 }),
    ).not.toBeNull();
    expect(
      await store!.saveLocation(hiderId, { ...base, clientSequence: 9 }),
    ).toBeNull();

    const [samples] = await connection!.sql<{ count: number }[]>`
      select count(*)::integer as count from location_samples
      where match_id=${matchId} and participant_id=${hiderId}
    `;
    const [latest] = await connection!.sql<{ clientSequence: number }[]>`
      select client_sequence::integer as "clientSequence" from latest_locations
      where participant_id=${hiderId}
    `;
    expect(samples?.count).toBe(1);
    expect(latest?.clientSequence).toBe(10);
  });
});

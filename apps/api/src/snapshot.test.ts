import type { MatchRuntime, ViewerContext } from "./store.js";
import type { Redis } from "ioredis";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildSnapshot } from "./snapshot.js";
import type { GameStore } from "./store.js";

const settings = {
  durationSeconds: 3600, hideSeconds: 0, tapTagEnabled: true, autoTagEnabled: false,
  tagRadiusMeters: 15, autoTagDwellSeconds: 5, tagCooldownSeconds: 5,
  positionMaxAgeSeconds: 15, maxAccuracyMeters: 50, maxSpeedMps: 15,
  caughtBehavior: "SPECTATOR" as const, boundaryGraceSeconds: 30,
  boundaryAudience: "HOST" as const, boundaryDisqualify: false,
};

function runtime(emergencyReveal = false): MatchRuntime {
  return {
    match: {
      id: "00000000-0000-4000-8000-000000000001", hostAccountId: "host", telegramChatId: null,
      name: "Secret hunt", state: "ACTIVE", stateBeforePause: null, winnerRole: null,
      phaseStartedAt: new Date("2026-08-21T12:00:00Z"), phaseEndsAt: new Date("2026-08-21T13:00:00Z"),
      activeStartedAt: new Date("2026-08-21T12:00:00Z"), pausedAt: null, pausedDurationMs: 0, emergencyReveal,
    },
    settings,
    rules: [{ observerRole: "HIDER", targetRole: "SEEKER", mode: "NEVER", visibleDurationSeconds: 10, cyclePeriodSeconds: 60, phaseOffsetSeconds: 0, persistLastSeen: false }],
    playzone: { type: "Polygon", coordinates: [[[0, 0], [0, 1], [1, 1], [0, 0]]] },
    participants: [
      { id: "hider", accountId: null, displayName: "Hidden viewer", role: "HIDER", status: "ACTIVE" },
      { id: "seeker", accountId: null, displayName: "Secret seeker", role: "SEEKER", status: "ACTIVE" },
    ],
    locations: [
      { participantId: "hider", displayName: "Hidden viewer", role: "HIDER", latitude: 1, longitude: 1, accuracyMeters: 5, speedMps: null, headingDegrees: null, recordedAt: "2026-08-21T12:00:25.000Z", clientSequence: 1 },
      { participantId: "seeker", displayName: "Secret seeker", role: "SEEKER", latitude: 2, longitude: 2, accuracyMeters: 5, speedMps: null, headingDegrees: null, recordedAt: "2026-08-21T12:00:25.000Z", clientSequence: 1 },
    ],
  };
}

const viewer: ViewerContext = { participantId: "hider", accountId: null, displayName: "Hidden viewer", role: "HIDER", isHost: false };
const redis = { hset: vi.fn(), hget: vi.fn().mockResolvedValue(null), expire: vi.fn() } as unknown as Redis;

describe("coordinate authorization", () => {
  afterEach(() => vi.useRealTimers());

  it("never serializes a target hidden from this viewer", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-08-21T12:00:30Z"));
    const store = { getRuntime: vi.fn().mockResolvedValue(runtime()) } as unknown as GameStore;
    const snapshot = await buildSnapshot(store, redis, "match", viewer);
    expect(snapshot.visiblePositions.map((position) => position.participantId)).toEqual(["hider"]);
    expect(JSON.stringify(snapshot)).not.toContain("Secret seeker\",\"role\":\"SEEKER\",\"latitude");
  });

  it("notifies a player about emergency mode without granting host-only coordinates", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-08-21T12:00:30Z"));
    const store = { getRuntime: vi.fn().mockResolvedValue(runtime(true)) } as unknown as GameStore;
    const snapshot = await buildSnapshot(store, redis, "match", viewer);
    expect(snapshot.emergencyReveal).toBe(true);
    expect(snapshot.visiblePositions.map((position) => position.participantId)).toEqual(["hider"]);
  });

  it("gives a spectator host the referee visibility rules", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-08-21T12:00:30Z"));
    const match = runtime();
    match.rules.push({ observerRole: "HOST", targetRole: "SEEKER", mode: "ALWAYS", visibleDurationSeconds: 10, cyclePeriodSeconds: 60, phaseOffsetSeconds: 0, persistLastSeen: false });
    const store = { getRuntime: vi.fn().mockResolvedValue(match) } as unknown as GameStore;
    const referee: ViewerContext = { participantId: "referee", accountId: "host", displayName: "Referee", role: "SPECTATOR", isHost: true };
    const snapshot = await buildSnapshot(store, redis, "match", referee);
    expect(snapshot.viewerIsHost).toBe(true);
    expect(snapshot.viewerRole).toBe("SPECTATOR");
    expect(snapshot.visiblePositions.map((position) => position.participantId)).toEqual(["seeker"]);
  });

  it("uses the host's chosen player role for visibility", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-08-21T12:00:30Z"));
    const match = runtime();
    match.rules.push({ observerRole: "HOST", targetRole: "SEEKER", mode: "ALWAYS", visibleDurationSeconds: 10, cyclePeriodSeconds: 60, phaseOffsetSeconds: 0, persistLastSeen: false });
    const store = { getRuntime: vi.fn().mockResolvedValue(match) } as unknown as GameStore;
    const playingHost: ViewerContext = { ...viewer, accountId: "host", isHost: true };
    const snapshot = await buildSnapshot(store, redis, "match", playingHost);
    expect(snapshot.viewerIsHost).toBe(true);
    expect(snapshot.viewerRole).toBe("HIDER");
    expect(snapshot.visiblePositions.map((position) => position.participantId)).toEqual(["hider"]);
  });
});

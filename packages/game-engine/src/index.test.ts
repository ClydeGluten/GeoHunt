import { describe, expect, it } from "vitest";
import type {
  MatchSettings,
  Position,
  VisibilityRule,
} from "@geohunter/contracts";
import {
  canRecordLocation,
  canTransition,
  mayObserve,
  revealState,
  validateLocation,
  validateTag,
  winnerFor,
} from "./index.js";

const settings: MatchSettings = {
  durationSeconds: 3600,
  hideSeconds: 300,
  tapTagEnabled: true,
  autoTagEnabled: false,
  tagRadiusMeters: 15,
  autoTagDwellSeconds: 5,
  tagCooldownSeconds: 5,
  positionMaxAgeSeconds: 15,
  maxAccuracyMeters: 50,
  maxSpeedMps: 15,
  caughtBehavior: "SPECTATOR",
  boundaryGraceSeconds: 30,
  boundaryAudience: "HOST",
  boundaryDisqualify: false,
};

const position = (
  longitude: number,
  recordedAt = "2026-08-21T12:00:00.000Z",
): Position => ({
  latitude: 51,
  longitude,
  accuracyMeters: 5,
  speedMps: null,
  headingDegrees: null,
  recordedAt,
});

describe("location recording lifecycle", () => {
  it("records only active player roles during hiding or active play", () => {
    expect(canRecordLocation("HIDING", "HIDER")).toBe(true);
    expect(canRecordLocation("ACTIVE", "SEEKER")).toBe(true);
    expect(canRecordLocation("LOBBY", "HIDER")).toBe(false);
    expect(canRecordLocation("PAUSED", "SEEKER")).toBe(false);
    expect(canRecordLocation("FINISHED", "HIDER")).toBe(false);
    expect(canRecordLocation("ACTIVE", "HOST")).toBe(false);
    expect(canRecordLocation("ACTIVE", "SPECTATOR")).toBe(false);
  });
});

describe("match state", () => {
  it("allows lobby start but blocks finished restart", () => {
    expect(canTransition("LOBBY", "HIDING")).toBe(true);
    expect(canTransition("FINISHED", "ACTIVE")).toBe(false);
  });
});

describe("visibility pulses", () => {
  const rule: VisibilityRule = {
    observerRole: "HIDER",
    targetRole: "SEEKER",
    mode: "PULSE",
    visibleDurationSeconds: 10,
    cyclePeriodSeconds: 60,
    phaseOffsetSeconds: 20,
    persistLastSeen: true,
  };
  const clock = {
    state: "ACTIVE" as const,
    activeStartedAt: new Date("2026-08-21T12:00:00.000Z"),
    phaseStartedAt: new Date("2026-08-21T12:00:00.000Z"),
    pausedAt: null,
    pausedDurationMs: 0,
    emergencyReveal: false,
  };

  it("honors offset, reveal, and frozen last seen", () => {
    expect(
      revealState(rule, clock, new Date("2026-08-21T12:00:10.000Z")),
    ).toMatchObject({ visible: false, frozen: true });
    expect(
      revealState(rule, clock, new Date("2026-08-21T12:00:25.000Z")),
    ).toMatchObject({ visible: true, frozen: false });
    expect(
      revealState(rule, clock, new Date("2026-08-21T12:00:40.000Z")),
    ).toMatchObject({ visible: false, frozen: true });
  });

  it("does not infer same-role visibility without an explicit rule", () => {
    expect(
      mayObserve(
        "HIDER",
        "HIDER",
        [],
        clock,
        new Date("2026-08-21T12:00:25.000Z"),
      ),
    ).toMatchObject({ visible: false });
  });
});

describe("location authority", () => {
  it("rejects impossible travel", () => {
    const decision = validateLocation(
      position(0, "2026-08-21T11:59:59.000Z"),
      position(0.01),
      settings,
      new Date("2026-08-21T12:00:00.000Z"),
    );
    expect(decision).toMatchObject({
      accepted: false,
      reason: "IMPOSSIBLE_SPEED",
    });
  });

  it("accepts nearby fresh tag", () => {
    const decision = validateTag(
      "ACTIVE",
      "SEEKER",
      "HIDER",
      position(0),
      position(0.0001),
      settings,
      new Date("2026-08-21T12:00:05.000Z"),
    );
    expect(decision.accepted).toBe(true);
  });
});

describe("win condition", () => {
  it("selects seeker when no hiders remain and hider on timeout", () => {
    expect(winnerFor(0, 2, false)).toBe("SEEKER");
    expect(winnerFor(2, 2, true)).toBe("HIDER");
  });
});

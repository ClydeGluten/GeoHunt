import type {
  MatchSettings,
  MatchState,
  PlayerRole,
  Position,
  VisibilityRule,
} from "@geohunter/contracts";

export interface MatchClock {
  state: MatchState;
  activeStartedAt: Date | null;
  phaseStartedAt: Date | null;
  pausedAt: Date | null;
  pausedDurationMs: number;
  emergencyReveal: boolean;
}

export interface LocationDecision {
  accepted: boolean;
  reason?:
    "STALE" | "INACCURATE" | "CLOCK_SKEW" | "IMPOSSIBLE_SPEED" | "DUPLICATE";
  calculatedSpeedMps?: number;
}

export interface TagDecision {
  accepted: boolean;
  reason?:
    | "MATCH_NOT_ACTIVE"
    | "INVALID_ROLE"
    | "STALE_POSITION"
    | "INACCURATE_POSITION"
    | "OUT_OF_RANGE";
  distanceMeters: number;
}

const transitionMap: Record<MatchState, MatchState[]> = {
  DRAFT: ["LOBBY", "CANCELED"],
  LOBBY: ["HIDING", "ACTIVE", "CANCELED"],
  HIDING: ["ACTIVE", "PAUSED", "FINISHED", "CANCELED"],
  ACTIVE: ["PAUSED", "FINISHED", "CANCELED"],
  PAUSED: ["HIDING", "ACTIVE", "FINISHED", "CANCELED"],
  FINISHED: [],
  CANCELED: [],
};

export function canRecordLocation(
  state: MatchState,
  role: PlayerRole,
): boolean {
  return (
    (state === "HIDING" || state === "ACTIVE") &&
    (role === "HIDER" || role === "SEEKER")
  );
}

export function canTransition(from: MatchState, to: MatchState): boolean {
  return transitionMap[from].includes(to);
}

export function assertTransition(from: MatchState, to: MatchState): void {
  if (!canTransition(from, to))
    throw new Error(`Invalid match transition: ${from} -> ${to}`);
}

export function elapsedActiveMs(clock: MatchClock, now: Date): number {
  if (!clock.activeStartedAt) return 0;
  const effectiveNow =
    clock.state === "PAUSED" && clock.pausedAt ? clock.pausedAt : now;
  return Math.max(
    0,
    effectiveNow.getTime() -
      clock.activeStartedAt.getTime() -
      clock.pausedDurationMs,
  );
}

export function revealState(
  rule: VisibilityRule | undefined,
  clock: MatchClock,
  now: Date,
): { visible: boolean; frozen: boolean; nextChangeAt: Date | null } {
  if (clock.emergencyReveal)
    return { visible: true, frozen: false, nextChangeAt: null };
  if (!rule || clock.state !== "ACTIVE" || rule.mode === "NEVER") {
    return {
      visible: false,
      frozen: Boolean(rule?.persistLastSeen),
      nextChangeAt: null,
    };
  }
  if (rule.mode === "ALWAYS")
    return { visible: true, frozen: false, nextChangeAt: null };

  const elapsedSeconds = elapsedActiveMs(clock, now) / 1000;
  if (elapsedSeconds < rule.phaseOffsetSeconds) {
    return {
      visible: false,
      frozen: rule.persistLastSeen,
      nextChangeAt: new Date(
        now.getTime() + (rule.phaseOffsetSeconds - elapsedSeconds) * 1000,
      ),
    };
  }

  const cycleElapsed =
    (elapsedSeconds - rule.phaseOffsetSeconds) % rule.cyclePeriodSeconds;
  const visible = cycleElapsed < rule.visibleDurationSeconds;
  const untilChange = visible
    ? rule.visibleDurationSeconds - cycleElapsed
    : rule.cyclePeriodSeconds - cycleElapsed;
  return {
    visible,
    frozen: !visible && rule.persistLastSeen,
    nextChangeAt: new Date(now.getTime() + untilChange * 1000),
  };
}

export function mayObserve(
  observer: PlayerRole,
  target: PlayerRole,
  rules: VisibilityRule[],
  clock: MatchClock,
  now: Date,
) {
  return revealState(
    rules.find(
      (rule) => rule.observerRole === observer && rule.targetRole === target,
    ),
    clock,
    now,
  );
}

export function haversineMeters(
  first: Pick<Position, "latitude" | "longitude">,
  second: Pick<Position, "latitude" | "longitude">,
): number {
  const radius = 6_371_000;
  const radians = (degrees: number) => (degrees * Math.PI) / 180;
  const deltaLatitude = radians(second.latitude - first.latitude);
  const deltaLongitude = radians(second.longitude - first.longitude);
  const latitude1 = radians(first.latitude);
  const latitude2 = radians(second.latitude);
  const a =
    Math.sin(deltaLatitude / 2) ** 2 +
    Math.cos(latitude1) *
      Math.cos(latitude2) *
      Math.sin(deltaLongitude / 2) ** 2;
  return 2 * radius * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function validateLocation(
  previous: Position | null,
  next: Position,
  settings: MatchSettings,
  serverNow: Date,
): LocationDecision {
  const recordedAt = new Date(next.recordedAt);
  const ageSeconds = (serverNow.getTime() - recordedAt.getTime()) / 1000;
  if (Math.abs(ageSeconds) > 120)
    return { accepted: false, reason: "CLOCK_SKEW" };
  if (ageSeconds > settings.positionMaxAgeSeconds)
    return { accepted: false, reason: "STALE" };
  if (next.accuracyMeters > settings.maxAccuracyMeters)
    return { accepted: false, reason: "INACCURATE" };
  if (!previous) return { accepted: true };

  const previousTime = new Date(previous.recordedAt).getTime();
  const nextTime = recordedAt.getTime();
  if (nextTime <= previousTime) return { accepted: false, reason: "DUPLICATE" };
  const seconds = (nextTime - previousTime) / 1000;
  const speed = haversineMeters(previous, next) / seconds;
  if (speed > settings.maxSpeedMps)
    return {
      accepted: false,
      reason: "IMPOSSIBLE_SPEED",
      calculatedSpeedMps: speed,
    };
  return { accepted: true, calculatedSpeedMps: speed };
}

export function validateTag(
  state: MatchState,
  seekerRole: PlayerRole,
  targetRole: PlayerRole,
  seeker: Position,
  target: Position,
  settings: MatchSettings,
  now: Date,
): TagDecision {
  const distanceMeters = haversineMeters(seeker, target);
  if (state !== "ACTIVE")
    return { accepted: false, reason: "MATCH_NOT_ACTIVE", distanceMeters };
  if (seekerRole !== "SEEKER" || targetRole !== "HIDER")
    return { accepted: false, reason: "INVALID_ROLE", distanceMeters };
  const oldest =
    Math.max(
      now.getTime() - new Date(seeker.recordedAt).getTime(),
      now.getTime() - new Date(target.recordedAt).getTime(),
    ) / 1000;
  if (oldest > settings.positionMaxAgeSeconds)
    return { accepted: false, reason: "STALE_POSITION", distanceMeters };
  if (
    seeker.accuracyMeters > settings.maxAccuracyMeters ||
    target.accuracyMeters > settings.maxAccuracyMeters
  ) {
    return { accepted: false, reason: "INACCURATE_POSITION", distanceMeters };
  }
  if (distanceMeters > settings.tagRadiusMeters)
    return { accepted: false, reason: "OUT_OF_RANGE", distanceMeters };
  return { accepted: true, distanceMeters };
}

export function winnerFor(
  activeHiders: number,
  activeSeekers: number,
  expired: boolean,
): "HIDER" | "SEEKER" | null {
  if (activeHiders === 0 && activeSeekers > 0) return "SEEKER";
  if (expired && activeHiders > 0) return "HIDER";
  return null;
}

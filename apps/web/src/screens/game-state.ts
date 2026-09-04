import type { MatchState, PlayerRole } from "@geohunter/contracts";

export function phaseSecondsLeft(
  state: MatchState,
  phaseEndsAt: string | null,
  pausedAt: string | null,
  now: number,
): number | null {
  if (!phaseEndsAt) return null;
  const effectiveNow =
    state === "PAUSED" && pausedAt ? new Date(pausedAt).getTime() : now;
  return Math.max(
    0,
    Math.ceil((new Date(phaseEndsAt).getTime() - effectiveNow) / 1000),
  );
}

export function taggedParticipantState(newRole: PlayerRole): {
  role: PlayerRole;
  status: "ACTIVE" | "TAGGED";
} {
  return {
    role: newRole,
    status: newRole === "SEEKER" ? "ACTIVE" : "TAGGED",
  };
}

export type MatchMenuMode = "manage" | "lobby" | "invite" | "results";

export function matchesForMode<T extends { state: string }>(
  matches: T[],
  mode: MatchMenuMode,
): T[] {
  return mode === "results"
    ? matches.filter((match) => match.state === "FINISHED")
    : matches;
}

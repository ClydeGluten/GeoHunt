import type { MatchSnapshot, VisiblePosition } from "@geohunter/contracts";
import { mayObserve } from "@geohunter/game-engine";
import type { Redis } from "ioredis";
import { viewerVisibilityRole, type GameStore, type ViewerContext } from "./store.js";

export async function buildSnapshot(store: GameStore, redis: Redis, matchId: string, viewer: ViewerContext): Promise<MatchSnapshot> {
  const runtime = await store.getRuntime(matchId);
  if (!runtime) throw new Error("Match not found");
  const now = new Date();
  const clock = {
    state: runtime.match.state,
    activeStartedAt: runtime.match.activeStartedAt,
    phaseStartedAt: runtime.match.phaseStartedAt,
    pausedAt: runtime.match.pausedAt,
    pausedDurationMs: runtime.match.pausedDurationMs,
    emergencyReveal: runtime.match.emergencyReveal && viewer.isHost,
  };
  const observerRole = viewerVisibilityRole(viewer);
  const cacheKey = `revealed:${matchId}:${viewer.participantId}`;
  const visiblePositions: VisiblePosition[] = [];

  for (const location of runtime.locations) {
    const authorization = mayObserve(observerRole, location.role, runtime.rules, clock, now);
    const stale = now.getTime() - new Date(location.recordedAt).getTime() > runtime.settings.positionMaxAgeSeconds * 1000;
    if (authorization.visible || location.participantId === viewer.participantId) {
      const visible: VisiblePosition = {
        participantId: location.participantId,
        displayName: location.displayName,
        role: location.role,
        latitude: location.latitude,
        longitude: location.longitude,
        accuracyMeters: location.accuracyMeters,
        speedMps: location.speedMps,
        headingDegrees: location.headingDegrees,
        recordedAt: location.recordedAt,
        stale,
        frozen: false,
      };
      visiblePositions.push(visible);
      await redis.hset(cacheKey, location.participantId, JSON.stringify(visible));
      await redis.expire(cacheKey, 86_400);
    } else if (authorization.frozen) {
      const cached = await redis.hget(cacheKey, location.participantId);
      if (cached) visiblePositions.push({ ...(JSON.parse(cached) as VisiblePosition), stale: true, frozen: true });
    }
  }

  return {
    id: runtime.match.id,
    name: runtime.match.name,
    state: runtime.match.state,
    viewerParticipantId: viewer.participantId,
    viewerRole: viewer.role,
    viewerIsHost: viewer.isHost,
    playzone: runtime.playzone,
    settings: runtime.settings,
    participants: runtime.participants.map((participant) => ({ ...participant, connected: false })),
    visiblePositions,
    phaseEndsAt: runtime.match.phaseEndsAt?.toISOString() ?? null,
    emergencyReveal: runtime.match.emergencyReveal,
  };
}

import type {
  ClientToServerEvents,
  LocationUpdate,
  ServerToClientEvents,
  VisiblePosition,
} from "@geohunter/contracts";
import { LocationUpdateSchema, TagAttemptSchema } from "@geohunter/contracts";
import {
  canRecordLocation,
  mayObserve,
  validateLocation,
  validateTag,
} from "@geohunter/game-engine";
import { createAdapter } from "@socket.io/redis-adapter";
import type { Server as HttpServer } from "node:http";
import type { Redis } from "ioredis";
import { Server, type Socket } from "socket.io";
import { z } from "zod";
import type { ApiConfig } from "./config.js";
import { parseCookieHeader } from "./security.js";
import { buildSnapshot } from "./snapshot.js";
import {
  viewerVisibilityRole,
  type GameStore,
  type MatchRuntime,
  type SessionContext,
  type ViewerContext,
} from "./store.js";

interface InterServerEvents {}
interface SocketData {
  token: string;
  session: SessionContext;
  viewer: ViewerContext;
  matchId: string;
}

type GameSocket = Socket<
  ClientToServerEvents,
  ServerToClientEvents,
  InterServerEvents,
  SocketData
>;

const PresenceHeartbeatSchema = z.object({ matchId: z.uuid() });
const LocationStatusSchema = z.object({
  matchId: z.uuid(),
  status: z.literal("DENIED"),
});

export function isAllowedRealtimeOrigin(
  origin: string | undefined,
  allowedOrigins: Iterable<string>,
): boolean {
  return !origin || new Set(allowedOrigins).has(origin);
}

export async function refreshSocketSession(
  store: GameStore,
  token: string,
  expectedSessionId: string,
): Promise<SessionContext | null> {
  const current = await store.getSession(token);
  return current?.id === expectedSessionId ? current : null;
}

export function runSocketTask(
  task: () => Promise<void>,
  onError: (error: unknown) => void = () => undefined,
): void {
  void task().catch(onError);
}

export async function consumeRateLimit(
  redis: Redis,
  key: string,
  limit: number,
  windowSeconds: number,
): Promise<boolean> {
  const count = await redis.eval(
    `
      local count = redis.call('INCR', KEYS[1])
      if count == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
      return count
    `,
    1,
    key,
    windowSeconds,
  );
  return Number(count) <= limit;
}

export function setupRealtime(
  httpServer: HttpServer,
  dependencies: {
    store: GameStore;
    redis: Redis;
    redisSubscriber: Redis;
    config: ApiConfig;
  },
) {
  const { store, redis, redisSubscriber, config } = dependencies;
  const allowedOrigins = config.CORS_ORIGIN.split(",").map((origin) =>
    origin.trim(),
  );
  const io = new Server<
    ClientToServerEvents,
    ServerToClientEvents,
    InterServerEvents,
    SocketData
  >(httpServer, {
    path: "/socket.io",
    cors: { origin: allowedOrigins, credentials: true },
    allowRequest: (request, callback) =>
      callback(
        null,
        isAllowedRealtimeOrigin(request.headers.origin, allowedOrigins),
      ),
    transports: ["websocket", "polling"],
    pingInterval: 15_000,
    pingTimeout: 20_000,
    maxHttpBufferSize: 64_000,
  });
  io.adapter(createAdapter(redis, redisSubscriber));

  io.use(async (socket, next) => {
    try {
      const token = parseCookieHeader(
        socket.handshake.headers.cookie,
        config.SESSION_COOKIE_NAME,
      );
      if (!token) return next(new Error("Authentication required"));
      const session = await store.getSession(token);
      if (!session) return next(new Error("Session expired"));
      const matchIdValue =
        socket.handshake.auth.matchId ?? socket.handshake.query.matchId;
      const matchId = typeof matchIdValue === "string" ? matchIdValue : null;
      if (!matchId) return next(new Error("matchId required"));
      const viewer = await store.getViewer(matchId, session);
      if (!viewer) return next(new Error("Match participant access required"));
      socket.data = { token, session, viewer, matchId };
      return next();
    } catch (error) {
      return next(
        error instanceof Error
          ? error
          : new Error("Realtime authentication failed"),
      );
    }
  });

  async function refreshViewer(socket: {
    data: SocketData;
    disconnect(close?: boolean): unknown;
  }): Promise<ViewerContext | null> {
    const session = await refreshSocketSession(
      store,
      socket.data.token,
      socket.data.session.id,
    );
    if (!session) {
      socket.disconnect(true);
      return null;
    }
    const viewer = await store.getViewer(socket.data.matchId, session);
    if (!viewer) {
      socket.disconnect(true);
      return null;
    }
    socket.data.session = session;
    socket.data.viewer = viewer;
    return viewer;
  }

  async function sendSnapshot(socket: GameSocket) {
    const viewer = await refreshViewer(socket);
    if (!viewer) return;
    const snapshot = await buildSnapshot(
      store,
      redis,
      socket.data.matchId,
      viewer,
    );
    socket.data.viewer.role = snapshot.viewerRole;
    const presence = await redis.smembers(`presence:${socket.data.matchId}`);
    snapshot.participants = snapshot.participants.map((participant) => ({
      ...participant,
      connected: presence.includes(participant.id),
    }));
    socket.emit("match:snapshot", snapshot);
  }

  async function sendSnapshots(matchId: string) {
    const sockets = await io.in(`match:${matchId}`).fetchSockets();
    await Promise.all(
      sockets.map(async (socket) => {
        try {
          const viewer = await refreshViewer(socket);
          if (!viewer) return;
          const snapshot = await buildSnapshot(store, redis, matchId, viewer);
          const presence = await redis.smembers(`presence:${matchId}`);
          snapshot.participants = snapshot.participants.map((participant) => ({
            ...participant,
            connected: presence.includes(participant.id),
          }));
          socket.emit("match:snapshot", snapshot);
        } catch {
          socket.emit("game:error", {
            code: "SNAPSHOT_FAILED",
            message: "Could not refresh match state",
          });
        }
      }),
    );
  }

  async function broadcastLocation(
    runtime: MatchRuntime,
    participantId: string,
    update: LocationUpdate,
  ) {
    const target = runtime.participants.find(
      (participant) => participant.id === participantId,
    );
    if (!target) return;
    const sockets = await io.in(`match:${runtime.match.id}`).fetchSockets();
    const now = new Date();
    for (const socket of sockets) {
      const viewer = await refreshViewer(socket);
      if (!viewer) continue;
      const clock = {
        state: runtime.match.state,
        activeStartedAt: runtime.match.activeStartedAt,
        phaseStartedAt: runtime.match.phaseStartedAt,
        pausedAt: runtime.match.pausedAt,
        pausedDurationMs: runtime.match.pausedDurationMs,
        emergencyReveal: runtime.match.emergencyReveal && viewer.isHost,
      };
      const authorization = mayObserve(
        viewerVisibilityRole(viewer),
        target.role,
        runtime.rules,
        clock,
        now,
      );
      if (!authorization.visible && viewer.participantId !== participantId)
        continue;
      const visible: VisiblePosition = {
        participantId,
        displayName: target.displayName,
        role: target.role,
        latitude: update.latitude,
        longitude: update.longitude,
        accuracyMeters: update.accuracyMeters,
        speedMps: update.speedMps,
        headingDegrees: update.headingDegrees,
        recordedAt: update.recordedAt,
        stale: false,
        frozen: false,
      };
      const key = `revealed:${runtime.match.id}:${viewer.participantId}`;
      await redis.hset(key, participantId, JSON.stringify(visible));
      await redis.expire(key, 86_400);
      socket.emit("visibility:update", { positions: [visible] });
    }
  }

  async function maybeAutoTag(
    runtime: MatchRuntime,
    seeker: ViewerContext,
    update: LocationUpdate,
  ) {
    if (
      !runtime.settings.autoTagEnabled ||
      seeker.role !== "SEEKER" ||
      runtime.match.state !== "ACTIVE"
    )
      return;
    const hiders = await store.activeHidersWithLocations(runtime.match.id);
    const seekerPosition = { ...update };
    for (const hider of hiders) {
      const key = `autotag:${runtime.match.id}:${seeker.participantId}:${hider.participantId}`;
      const decision = validateTag(
        runtime.match.state,
        "SEEKER",
        "HIDER",
        seekerPosition,
        hider,
        runtime.settings,
        new Date(),
      );
      if (!decision.accepted) {
        await redis.del(key);
        continue;
      }
      const started = await redis.get(key);
      if (!started) {
        await redis.set(
          key,
          String(Date.now()),
          "EX",
          runtime.settings.autoTagDwellSeconds + 30,
        );
        continue;
      }
      if (
        Date.now() - Number(started) <
        runtime.settings.autoTagDwellSeconds * 1000
      )
        continue;
      const cooldownKey = `tagcooldown:${runtime.match.id}:${seeker.participantId}`;
      if (await redis.exists(cooldownKey)) continue;
      const spatial = await store.isTagWithin(
        runtime.match.id,
        seeker.participantId,
        hider.participantId,
        runtime.settings.tagRadiusMeters,
      );
      if (!spatial.within) continue;
      const result = await store.applyTag(
        runtime.match.id,
        seeker.participantId,
        hider.participantId,
        runtime.settings.caughtBehavior,
        spatial.distanceMeters,
      );
      await redis.del(key);
      if (result.applied) {
        if (runtime.settings.tagCooldownSeconds > 0)
          await redis.set(
            cooldownKey,
            "1",
            "EX",
            runtime.settings.tagCooldownSeconds,
          );
        const newRole =
          runtime.settings.caughtBehavior === "SEEKER" ? "SEEKER" : "SPECTATOR";
        io.to(`match:${runtime.match.id}`).emit("participant:tagged", {
          participantId: hider.participantId,
          newRole,
        });
        if (result.finished)
          io.to(`match:${runtime.match.id}`).emit("match:finished", {
            winnerRole: "SEEKER",
          });
      }
    }
  }

  io.on("connection", (socket) => {
    runSocketTask(
      async () => {
        const { matchId, viewer } = socket.data;
        await socket.join(`match:${matchId}`);
        await redis.sadd(`presence:${matchId}`, viewer.participantId);
        await redis.expire(`presence:${matchId}`, 120);
        io.to(`match:${matchId}`).emit("presence:update", {
          participantId: viewer.participantId,
          connected: true,
        });
        await sendSnapshot(socket).catch(() =>
          socket.emit("game:error", {
            code: "SNAPSHOT_FAILED",
            message: "Could not load match",
          }),
        );

        socket.on("presence:heartbeat", (raw) => {
          runSocketTask(async () => {
            const parsed = PresenceHeartbeatSchema.safeParse(raw);
            if (!parsed.success || parsed.data.matchId !== matchId) return;
            const currentViewer = await refreshViewer(socket);
            if (!currentViewer) return;
            if (
              !(await consumeRateLimit(
                redis,
                `rate:presence:${matchId}:${currentViewer.participantId}`,
                2,
                1,
              ))
            )
              return;
            await redis.sadd(
              `presence:${matchId}`,
              currentViewer.participantId,
            );
            await redis.expire(`presence:${matchId}`, 120);
          });
        });

        socket.on("location:update", async (raw, acknowledge) => {
          try {
            const update = LocationUpdateSchema.parse(raw);
            if (update.matchId !== matchId) throw new Error("Match mismatch");
            const currentViewer = await refreshViewer(socket);
            if (!currentViewer) {
              acknowledge?.({ accepted: false, reason: "SESSION_EXPIRED" });
              return;
            }
            if (
              !(await consumeRateLimit(
                redis,
                `rate:location:${matchId}:${viewer.participantId}`,
                10,
                1,
              ))
            ) {
              acknowledge?.({ accepted: false, reason: "RATE_LIMITED" });
              return;
            }
            const runtime = await store.getRuntime(matchId);
            if (!runtime) throw new Error("Match missing");
            const currentParticipant = runtime.participants.find(
              (participant) => participant.id === viewer.participantId,
            );
            if (
              !currentParticipant ||
              currentParticipant.status !== "ACTIVE" ||
              !canRecordLocation(runtime.match.state, currentParticipant.role)
            ) {
              throw new Error(
                "Location is accepted only from active players during a live phase",
              );
            }
            socket.data.viewer.role = currentParticipant.role;
            const previous = await store.getPreviousPosition(
              viewer.participantId,
            );
            if (previous && update.clientSequence <= previous.clientSequence) {
              acknowledge?.({ accepted: false, reason: "STALE_SEQUENCE" });
              return;
            }
            const decision = validateLocation(
              previous,
              update,
              runtime.settings,
              new Date(),
            );
            if (!decision.accepted) {
              await store.recordRejectedLocation(
                viewer.participantId,
                matchId,
                decision.reason ?? "UNKNOWN",
                update,
              );
              if (decision.reason === "INACCURATE") {
                const inaccurateKey = `inaccurate:${matchId}:${viewer.participantId}`;
                const count = await redis.incr(inaccurateKey);
                await redis.expire(inaccurateKey, 120);
                if (
                  count >= 6 &&
                  (await store.forceSpectator(
                    matchId,
                    viewer.participantId,
                    "INACCURATE",
                  ))
                ) {
                  socket.emit("game:error", {
                    code: "GPS_INACCURATE",
                    message:
                      "GPS stayed too inaccurate; you are now a spectator",
                  });
                  await sendSnapshots(matchId);
                }
              }
              acknowledge?.({
                accepted: false,
                reason: decision.reason ?? "Location rejected",
              });
              return;
            }
            await redis.del(`inaccurate:${matchId}:${viewer.participantId}`);
            const boundary = await store.saveLocation(
              viewer.participantId,
              update,
            );
            if (!boundary) {
              acknowledge?.({ accepted: false, reason: "STALE_SEQUENCE" });
              return;
            }
            socket.emit("boundary:update", {
              participantId: viewer.participantId,
              outside: boundary.outside,
              graceEndsAt: boundary.graceEndsAt?.toISOString() ?? null,
            });
            if (boundary.actionApplied) {
              const sockets = await io.in(`match:${matchId}`).fetchSockets();
              for (const recipient of sockets) {
                const role = recipient.data.viewer.role;
                const notify =
                  recipient.data.viewer.isHost ||
                  runtime.settings.boundaryAudience === "ALL" ||
                  (runtime.settings.boundaryAudience === "SEEKERS" &&
                    role === "SEEKER");
                if (notify)
                  recipient.emit("boundary:update", {
                    participantId: viewer.participantId,
                    outside: true,
                    graceEndsAt: boundary.graceEndsAt?.toISOString() ?? null,
                  });
              }
            }
            await broadcastLocation(runtime, viewer.participantId, update);
            await maybeAutoTag(
              runtime,
              { ...viewer, role: currentParticipant.role },
              update,
            );
            acknowledge?.({ accepted: true });
          } catch (error) {
            acknowledge?.({
              accepted: false,
              reason:
                error instanceof Error ? error.message : "Location failed",
            });
          }
        });

        socket.on("location:status", (raw) => {
          runSocketTask(async () => {
            const parsed = LocationStatusSchema.safeParse(raw);
            if (!parsed.success || parsed.data.matchId !== matchId) return;
            const currentViewer = await refreshViewer(socket);
            if (!currentViewer) return;
            if (
              !(await consumeRateLimit(
                redis,
                `rate:location-status:${matchId}:${currentViewer.participantId}`,
                3,
                60,
              ))
            )
              return;
            if (
              await store.forceSpectator(
                matchId,
                currentViewer.participantId,
                "DENIED",
              )
            ) {
              socket.emit("game:error", {
                code: "GPS_DENIED",
                message:
                  "Location is required to play; you are now a spectator",
              });
              await sendSnapshots(matchId);
            }
          });
        });

        socket.on("tag:attempt", async (raw, acknowledge) => {
          try {
            const attempt = TagAttemptSchema.parse(raw);
            if (attempt.matchId !== matchId) throw new Error("Match mismatch");
            const currentViewer = await refreshViewer(socket);
            if (!currentViewer) {
              acknowledge?.({ accepted: false, reason: "SESSION_EXPIRED" });
              return;
            }
            if (
              !(await consumeRateLimit(
                redis,
                `rate:tag:${matchId}:${currentViewer.participantId}`,
                5,
                1,
              ))
            ) {
              acknowledge?.({ accepted: false, reason: "RATE_LIMITED" });
              return;
            }
            const runtime = await store.getRuntime(matchId);
            if (!runtime || !runtime.settings.tapTagEnabled)
              throw new Error("Tap tagging disabled");
            const data = await store.loadTagData(
              matchId,
              viewer.participantId,
              attempt.targetParticipantId,
            );
            if (!data.seeker || !data.target)
              throw new Error("Fresh positions required");
            const decision = validateTag(
              runtime.match.state,
              data.seeker.role,
              data.target.role,
              data.seeker,
              data.target,
              runtime.settings,
              new Date(),
            );
            if (!decision.accepted) {
              acknowledge?.({
                accepted: false,
                reason: decision.reason ?? "Tag rejected",
              });
              return;
            }
            const cooldownKey = `tagcooldown:${matchId}:${viewer.participantId}`;
            if (await redis.exists(cooldownKey))
              return acknowledge?.({ accepted: false, reason: "COOLDOWN" });
            const spatial = await store.isTagWithin(
              matchId,
              viewer.participantId,
              attempt.targetParticipantId,
              runtime.settings.tagRadiusMeters,
            );
            if (!spatial.within)
              return acknowledge?.({ accepted: false, reason: "OUT_OF_RANGE" });
            const result = await store.applyTag(
              matchId,
              viewer.participantId,
              attempt.targetParticipantId,
              runtime.settings.caughtBehavior,
              spatial.distanceMeters,
            );
            if (!result.applied) throw new Error("Target already caught");
            if (runtime.settings.tagCooldownSeconds > 0)
              await redis.set(
                cooldownKey,
                "1",
                "EX",
                runtime.settings.tagCooldownSeconds,
              );
            const newRole =
              runtime.settings.caughtBehavior === "SEEKER"
                ? "SEEKER"
                : "SPECTATOR";
            io.to(`match:${matchId}`).emit("participant:tagged", {
              participantId: attempt.targetParticipantId,
              newRole,
            });
            if (result.finished)
              io.to(`match:${matchId}`).emit("match:finished", {
                winnerRole: "SEEKER",
              });
            acknowledge?.({ accepted: true });
          } catch (error) {
            acknowledge?.({
              accepted: false,
              reason: error instanceof Error ? error.message : "Tag failed",
            });
          }
        });

        socket.on("disconnect", () => {
          runSocketTask(async () => {
            const others = await io.in(`match:${matchId}`).fetchSockets();
            if (
              !others.some(
                (candidate) =>
                  candidate.data.viewer.participantId === viewer.participantId,
              )
            ) {
              await redis.srem(`presence:${matchId}`, viewer.participantId);
              io.to(`match:${matchId}`).emit("presence:update", {
                participantId: viewer.participantId,
                connected: false,
              });
            }
          });
        });
      },
      () => {
        socket.emit("game:error", {
          code: "CONNECTION_SETUP_FAILED",
          message: "Could not initialize realtime state",
        });
        socket.disconnect(true);
      },
    );
  });

  let tick = 0;
  const timer = setInterval(async () => {
    try {
      const changed = await store.advanceTimers();
      for (const item of changed) {
        io.to(`match:${item.matchId}`).emit("phase:changed", {
          state: item.state,
          phaseEndsAt: null,
        });
        if (item.state === "FINISHED")
          io.to(`match:${item.matchId}`).emit("match:finished", {
            winnerRole: "HIDER",
          });
      }
      tick += 1;
      if (tick % 5 === 0) {
        const rooms = [...io.sockets.adapter.rooms.keys()].filter((room) =>
          room.startsWith("match:"),
        );
        await Promise.all(rooms.map((room) => sendSnapshots(room.slice(6))));
      }
    } catch {
      // Next tick retries; database timestamps remain source of truth.
    }
  }, 1000);
  timer.unref();

  return {
    io,
    close: async () => {
      clearInterval(timer);
      await io.close();
    },
  };
}

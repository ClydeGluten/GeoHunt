import type {
  ClientToServerEvents,
  CreateMatchInput,
  LocationUpdate,
  PlayerRole,
  ServerToClientEvents,
} from "@geohunter/contracts";
import { io, type Socket } from "socket.io-client";

export const DEMO_FRAME_INTERVAL_MS = 1_000;
export const DEMO_FRAME_COUNT = 65;

export const DEMO_MATCH_INPUT: CreateMatchInput = {
  name: "GeoHunt judge demo",
  playzone: {
    type: "Polygon",
    coordinates: [
      [
        [65.488, 44.838],
        [65.494, 44.838],
        [65.494, 44.843],
        [65.488, 44.843],
        [65.488, 44.838],
      ],
    ],
  },
  settings: {
    durationSeconds: 60,
    hideSeconds: 5,
    tapTagEnabled: true,
    autoTagEnabled: true,
    tagRadiusMeters: 15,
    autoTagDwellSeconds: 3,
    tagCooldownSeconds: 0,
    positionMaxAgeSeconds: 15,
    maxAccuracyMeters: 25,
    maxSpeedMps: 15,
    caughtBehavior: "SPECTATOR",
    boundaryGraceSeconds: 10,
    boundaryAudience: "ALL",
    boundaryDisqualify: false,
  },
  visibilityRules: [
    {
      observerRole: "HOST",
      targetRole: "HIDER",
      mode: "ALWAYS",
      visibleDurationSeconds: 10,
      cyclePeriodSeconds: 60,
      phaseOffsetSeconds: 0,
      persistLastSeen: true,
    },
    {
      observerRole: "HOST",
      targetRole: "SEEKER",
      mode: "ALWAYS",
      visibleDurationSeconds: 10,
      cyclePeriodSeconds: 60,
      phaseOffsetSeconds: 0,
      persistLastSeen: true,
    },
    {
      observerRole: "SEEKER",
      targetRole: "HIDER",
      mode: "PULSE",
      visibleDurationSeconds: 4,
      cyclePeriodSeconds: 12,
      phaseOffsetSeconds: 0,
      persistLastSeen: true,
    },
    {
      observerRole: "HIDER",
      targetRole: "SEEKER",
      mode: "ALWAYS",
      visibleDurationSeconds: 10,
      cyclePeriodSeconds: 60,
      phaseOffsetSeconds: 0,
      persistLastSeen: true,
    },
  ],
  consentLocation: true,
  consentReplay: true,
};

export interface DemoMatchStore {
  createWebAccount(
    displayName: string,
  ): Promise<{ id: string; displayName: string }>;
  createSession(input: {
    kind: "WEB";
    accountId: string;
    days: number;
    demo?: boolean;
  }): Promise<{ token: string; expiresAt: Date }>;
  createMatch(
    accountId: string,
    input: CreateMatchInput,
  ): Promise<{ matchId: string; inviteCode: string; participantId: string }>;
  joinGuestSession(
    inviteCode: string,
    displayName: string,
    days: number,
  ): Promise<{
    participantId: string;
    matchId: string;
    token: string;
    expiresAt: Date;
  }>;
  assignRole(
    matchId: string,
    participantId: string,
    role: Exclude<PlayerRole, "HOST">,
  ): Promise<void>;
  performAction(
    matchId: string,
    actorParticipantId: string,
    action: "OPEN_LOBBY" | "START",
  ): Promise<unknown>;
}

export interface DemoActor {
  participantId: string;
  token: string;
  path: "HIDER_ONE" | "HIDER_TWO" | "SEEKER";
}

export interface DemoLocationConnection {
  send(participantId: string, update: LocationUpdate): Promise<void>;
  close(): void;
}

export interface DemoLocationTransport {
  connect(
    matchId: string,
    actors: DemoActor[],
  ): Promise<DemoLocationConnection>;
}

export interface DemoSession {
  matchId: string;
  token: string;
  expiresAt: Date;
  completion: Promise<void>;
}

function demoCoordinate(
  path: DemoActor["path"],
  frame: number,
): readonly [latitude: number, longitude: number] {
  if (path === "HIDER_ONE") return [44.8402 + frame * 0.000_005, 65.4905];
  if (path === "SEEKER") return [44.8399 + frame * 0.000_012, 65.4905];
  return [44.8412 - frame * 0.000_004, 65.492 - frame * 0.000_003];
}

export function demoLocationUpdate(
  matchId: string,
  actor: DemoActor,
  frame: number,
  recordedAt: Date,
): LocationUpdate {
  const [latitude, longitude] = demoCoordinate(actor.path, frame);
  return {
    matchId,
    latitude,
    longitude,
    accuracyMeters: 5,
    speedMps: null,
    headingDegrees: null,
    recordedAt: recordedAt.toISOString(),
    clientSequence: frame + 1,
    source: "BROWSER",
  };
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export class DemoMatchCoordinator {
  private current: Promise<DemoSession> | null = null;

  constructor(
    private readonly store: DemoMatchStore,
    private readonly transport: DemoLocationTransport,
    private readonly wait: (milliseconds: number) => Promise<void> = sleep,
    private readonly now: () => Date = () => new Date(),
    private readonly onError: (error: unknown) => void = () => undefined,
  ) {}

  start(): Promise<DemoSession> {
    if (!this.current) {
      this.current = this.create().catch((error) => {
        this.current = null;
        throw error;
      });
    }
    return this.current;
  }

  private async create(): Promise<DemoSession> {
    const host = await this.store.createWebAccount("Demo Host");
    const hostSession = await this.store.createSession({
      kind: "WEB",
      accountId: host.id,
      days: 1,
      demo: true,
    });
    const match = await this.store.createMatch(host.id, DEMO_MATCH_INPUT);
    await this.store.performAction(
      match.matchId,
      match.participantId,
      "OPEN_LOBBY",
    );

    const joined = await Promise.all([
      this.store.joinGuestSession(match.inviteCode, "Iris", 1),
      this.store.joinGuestSession(match.inviteCode, "Moss", 1),
      this.store.joinGuestSession(match.inviteCode, "Flint", 1),
    ]);
    const firstHider = joined[0];
    const secondHider = joined[1];
    const seeker = joined[2];
    if (!firstHider || !secondHider || !seeker)
      throw new Error("Demo participants could not be created");

    await Promise.all([
      this.store.assignRole(match.matchId, firstHider.participantId, "HIDER"),
      this.store.assignRole(match.matchId, secondHider.participantId, "HIDER"),
      this.store.assignRole(match.matchId, seeker.participantId, "SEEKER"),
    ]);
    await this.store.performAction(match.matchId, match.participantId, "START");

    const actors: DemoActor[] = [
      {
        participantId: firstHider.participantId,
        token: firstHider.token,
        path: "HIDER_ONE",
      },
      {
        participantId: secondHider.participantId,
        token: secondHider.token,
        path: "HIDER_TWO",
      },
      {
        participantId: seeker.participantId,
        token: seeker.token,
        path: "SEEKER",
      },
    ];
    const connection = await this.transport.connect(match.matchId, actors);
    const completion = this.play(match.matchId, actors, connection);
    completion.catch(this.onError);

    return {
      matchId: match.matchId,
      token: hostSession.token,
      expiresAt: hostSession.expiresAt,
      completion,
    };
  }

  private async play(
    matchId: string,
    actors: DemoActor[],
    connection: DemoLocationConnection,
  ): Promise<void> {
    try {
      for (let frame = 0; frame < DEMO_FRAME_COUNT; frame += 1) {
        const recordedAt = this.now();
        await Promise.all(
          actors.map((actor) =>
            connection.send(
              actor.participantId,
              demoLocationUpdate(matchId, actor, frame, recordedAt),
            ),
          ),
        );
        await this.wait(DEMO_FRAME_INTERVAL_MS);
      }
    } finally {
      connection.close();
    }
  }
}

type DemoSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

function connectSocket(
  url: string,
  matchId: string,
  cookieName: string,
  token: string,
): Promise<DemoSocket> {
  return new Promise((resolve, reject) => {
    const socket: DemoSocket = io(url, {
      auth: { matchId },
      transports: ["websocket"],
      extraHeaders: { Cookie: `${cookieName}=${token}` },
      reconnection: false,
    });
    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error("Demo player could not connect to realtime"));
    }, 5_000);
    socket.once("match:snapshot", () => {
      clearTimeout(timeout);
      resolve(socket);
    });
    socket.once("connect_error", (error) => {
      clearTimeout(timeout);
      socket.close();
      reject(error);
    });
  });
}

export class SocketIoDemoTransport implements DemoLocationTransport {
  constructor(
    private readonly url: string,
    private readonly cookieName: string,
  ) {}

  async connect(
    matchId: string,
    actors: DemoActor[],
  ): Promise<DemoLocationConnection> {
    const sockets = await Promise.all(
      actors.map((actor) =>
        connectSocket(this.url, matchId, this.cookieName, actor.token),
      ),
    );
    const byParticipant = new Map(
      actors.map((actor, index) => [actor.participantId, sockets[index]!]),
    );
    return {
      send: async (participantId, update) => {
        const socket = byParticipant.get(participantId);
        if (!socket) throw new Error("Demo realtime participant is missing");
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(
            () => reject(new Error("Demo location acknowledgement timed out")),
            3_000,
          );
          socket.emit("location:update", update, (result) => {
            clearTimeout(timeout);
            if (
              result.accepted ||
              result.reason ===
                "Location is accepted only from active players during a live phase"
            )
              resolve();
            else
              reject(
                new Error(
                  `Demo location rejected: ${result.reason ?? "UNKNOWN"}`,
                ),
              );
          });
        });
      },
      close: () => sockets.forEach((socket) => socket.close()),
    };
  }
}

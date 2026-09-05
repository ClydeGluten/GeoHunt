import type { LocationUpdate } from "@geohunter/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  DEMO_FRAME_COUNT,
  DEMO_FRAME_INTERVAL_MS,
  DEMO_MATCH_INPUT,
  DemoMatchCoordinator,
  demoLocationUpdate,
  type DemoActor,
  type DemoLocationTransport,
  type DemoMatchStore,
} from "./demo.js";

function harness() {
  let timeMs = Date.parse("2026-09-05T12:00:00.000Z");
  const sent: Array<{ participantId: string; update: LocationUpdate }> = [];
  const store: DemoMatchStore = {
    createWebAccount: vi
      .fn()
      .mockResolvedValue({ id: "host-account", displayName: "Demo Host" }),
    createSession: vi.fn().mockResolvedValue({
      token: "host-token",
      expiresAt: new Date("2026-09-06T12:00:00.000Z"),
    }),
    createMatch: vi.fn().mockResolvedValue({
      matchId: "00000000-0000-4000-8000-000000000001",
      participantId: "host-participant",
      inviteCode: "demo-invite-code",
    }),
    joinGuestSession: vi
      .fn()
      .mockResolvedValueOnce({
        matchId: "00000000-0000-4000-8000-000000000001",
        participantId: "hider-one",
        token: "hider-one-token",
        expiresAt: new Date("2026-09-06T12:00:00.000Z"),
      })
      .mockResolvedValueOnce({
        matchId: "00000000-0000-4000-8000-000000000001",
        participantId: "hider-two",
        token: "hider-two-token",
        expiresAt: new Date("2026-09-06T12:00:00.000Z"),
      })
      .mockResolvedValueOnce({
        matchId: "00000000-0000-4000-8000-000000000001",
        participantId: "seeker",
        token: "seeker-token",
        expiresAt: new Date("2026-09-06T12:00:00.000Z"),
      }),
    assignRole: vi.fn(),
    performAction: vi.fn(),
  };
  const close = vi.fn();
  const transport: DemoLocationTransport = {
    connect: vi.fn().mockResolvedValue({
      send: async (participantId: string, update: LocationUpdate) => {
        sent.push({ participantId, update });
      },
      close,
    }),
  };
  const wait = async (milliseconds: number) => {
    timeMs += milliseconds;
  };
  return {
    store,
    transport,
    sent,
    close,
    coordinator: new DemoMatchCoordinator(
      store,
      transport,
      wait,
      () => new Date(timeMs),
    ),
  };
}

describe("judge demo coordinator", () => {
  it("starts one seeker and two hiders, then records about 65 seconds", async () => {
    const demo = harness();

    const session = await demo.coordinator.start();
    await session.completion;
    expect(demo.store.createSession).toHaveBeenCalledWith({
      kind: "WEB",
      accountId: "host-account",
      days: 1,
      demo: true,
    });

    expect(demo.store.createMatch).toHaveBeenCalledWith(
      "host-account",
      DEMO_MATCH_INPUT,
    );
    expect(demo.store.joinGuestSession).toHaveBeenCalledTimes(3);
    expect(demo.store.assignRole).toHaveBeenNthCalledWith(
      1,
      session.matchId,
      "hider-one",
      "HIDER",
    );
    expect(demo.store.assignRole).toHaveBeenNthCalledWith(
      2,
      session.matchId,
      "hider-two",
      "HIDER",
    );
    expect(demo.store.assignRole).toHaveBeenNthCalledWith(
      3,
      session.matchId,
      "seeker",
      "SEEKER",
    );
    expect(demo.store.performAction).toHaveBeenNthCalledWith(
      1,
      session.matchId,
      "host-participant",
      "OPEN_LOBBY",
    );
    expect(demo.store.performAction).toHaveBeenNthCalledWith(
      2,
      session.matchId,
      "host-participant",
      "START",
    );
    expect(demo.sent).toHaveLength(DEMO_FRAME_COUNT * 3);
    expect(demo.sent.at(-1)?.update.recordedAt).toBe(
      new Date(
        Date.parse("2026-09-05T12:00:00.000Z") +
          (DEMO_FRAME_COUNT - 1) * DEMO_FRAME_INTERVAL_MS,
      ).toISOString(),
    );
    expect(demo.close).toHaveBeenCalledOnce();
  });

  it("reuses the same match when the demo URL is refreshed", async () => {
    const demo = harness();

    const first = await demo.coordinator.start();
    const second = await demo.coordinator.start();
    await first.completion;

    expect(second.matchId).toBe(first.matchId);
    expect(demo.store.createMatch).toHaveBeenCalledOnce();
  });

  it("generates deterministic, slowly moving actor locations", () => {
    const actor: DemoActor = {
      participantId: "seeker",
      token: "secret",
      path: "SEEKER",
    };
    const at = new Date("2026-09-05T12:00:10.000Z");

    expect(demoLocationUpdate("match", actor, 10, at)).toEqual(
      demoLocationUpdate("match", actor, 10, at),
    );
    expect(demoLocationUpdate("match", actor, 11, at).latitude).toBeGreaterThan(
      demoLocationUpdate("match", actor, 10, at).latitude,
    );
  });
});

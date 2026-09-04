import type { Redis } from "ioredis";
import { describe, expect, it, vi } from "vitest";
import type { GameStore } from "./store.js";
import {
  consumeRateLimit,
  isAllowedRealtimeOrigin,
  refreshSocketSession,
  runSocketTask,
} from "./realtime.js";

describe("realtime origin checks", () => {
  const allowed = ["https://game.example", "https://admin.example"];

  it("rejects browser websocket handshakes from other origins", () => {
    expect(isAllowedRealtimeOrigin("https://evil.example", allowed)).toBe(
      false,
    );
    expect(isAllowedRealtimeOrigin("https://game.example", allowed)).toBe(true);
  });

  it("allows clients that do not send a browser Origin header", () => {
    expect(isAllowedRealtimeOrigin(undefined, allowed)).toBe(true);
  });
});

describe("realtime event isolation", () => {
  it("contains rejected async handlers instead of leaking an unhandled rejection", async () => {
    const onError = vi.fn();

    runSocketTask(async () => {
      throw new Error("malformed event");
    }, onError);
    await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce());

    expect(onError).toHaveBeenCalledWith(expect.any(Error));
  });
});

describe("realtime session refresh", () => {
  it("rejects a socket after its cookie session is revoked", async () => {
    const getSession = vi.fn().mockResolvedValue(null);
    const store = { getSession } as unknown as GameStore;

    await expect(
      refreshSocketSession(store, "revoked-token", "old-session-id"),
    ).resolves.toBeNull();
    expect(getSession).toHaveBeenCalledWith("revoked-token");
  });

  it("rejects a token that now resolves to a different session", async () => {
    const getSession = vi.fn().mockResolvedValue({
      id: "new-session-id",
      kind: "WEB",
      accountId: "account-id",
      participantId: null,
      expiresAt: new Date("2027-01-01T00:00:00Z"),
    });
    const store = { getSession } as unknown as GameStore;

    await expect(
      refreshSocketSession(store, "reused-token", "old-session-id"),
    ).resolves.toBeNull();
  });
});

describe("realtime rate limits", () => {
  it("rejects events after the participant exceeds the shared limit", async () => {
    const redis = {
      eval: vi
        .fn()
        .mockResolvedValueOnce(1)
        .mockResolvedValueOnce(2)
        .mockResolvedValueOnce(3),
    } as unknown as Redis;

    await expect(consumeRateLimit(redis, "rate:key", 2, 1)).resolves.toBe(true);
    await expect(consumeRateLimit(redis, "rate:key", 2, 1)).resolves.toBe(true);
    await expect(consumeRateLimit(redis, "rate:key", 2, 1)).resolves.toBe(
      false,
    );
    expect(redis.eval).toHaveBeenCalledWith(
      expect.any(String),
      1,
      "rate:key",
      1,
    );
  });
});

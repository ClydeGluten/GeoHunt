import cookie from "@fastify/cookie";
import Fastify from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";
import type { Redis } from "ioredis";
import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { ApiConfig } from "./config.js";
import { purgeRevealedLocations, registerRoutes } from "./routes.js";
import type { GameStore } from "./store.js";

const config = {
  NODE_ENV: "test",
  PORT: 3000,
  HOST: "127.0.0.1",
  DATABASE_URL: "postgres://test:test@localhost/test",
  REDIS_URL: "redis://localhost:6379",
  BOT_TOKEN: "development-bot-token",
  BOT_SERVICE_TOKEN: "development-service-token",
  SESSION_COOKIE_NAME: "geohunter_session",
  SESSION_DAYS: 30,
  TELEGRAM_AUTH_MAX_AGE_SECONDS: 3600,
  PUBLIC_WEBAPP_URL: "https://game.example",
  CORS_ORIGIN: "https://game.example",
  DEV_AUTH_ENABLED: false,
  COOKIE_SECURE: true,
  LOG_LEVEL: "silent",
} satisfies ApiConfig;

const createInput = {
  name: "Browser hunt",
  playzone: {
    type: "Polygon" as const,
    coordinates: [
      [
        [0, 0],
        [0, 1],
        [1, 1],
        [0, 0],
      ],
    ],
  },
  settings: {
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
    caughtBehavior: "SPECTATOR" as const,
    boundaryGraceSeconds: 30,
    boundaryAudience: "HOST" as const,
    boundaryDisqualify: false,
  },
  visibilityRules: [],
  consentLocation: true,
  consentReplay: true,
};

describe("browser host authorization", () => {
  it("allows a browser account to create a match", async () => {
    const createMatch = vi.fn().mockResolvedValue({
      matchId: "00000000-0000-4000-8000-000000000001",
      participantId: "00000000-0000-4000-8000-000000000002",
      inviteCode: "invite-code",
    });
    const store = { createMatch } as unknown as GameStore;
    const app = Fastify({ logger: false });
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    app.decorateRequest("session", null);
    app.addHook("onRequest", async (request) => {
      request.session = {
        id: "00000000-0000-4000-8000-000000000003",
        kind: "WEB",
        accountId: "00000000-0000-4000-8000-000000000004",
        participantId: null,
        expiresAt: new Date("2027-01-01T00:00:00Z"),
      };
    });
    await registerRoutes(app, {
      store,
      redis: { eval: vi.fn().mockResolvedValue(1) } as unknown as Redis,
      config,
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/matches",
      payload: createInput,
    });

    expect(response.statusCode).toBe(201);
    expect(createMatch).toHaveBeenCalledWith(
      "00000000-0000-4000-8000-000000000004",
      createInput,
    );
    await app.close();
  });

  it("does not let a browser account claim a Telegram chat", async () => {
    const createMatch = vi.fn().mockResolvedValue({
      matchId: "00000000-0000-4000-8000-000000000001",
      participantId: "00000000-0000-4000-8000-000000000002",
      inviteCode: "invite-code",
    });
    const store = { createMatch } as unknown as GameStore;
    const app = Fastify({ logger: false });
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    app.decorateRequest("session", null);
    app.addHook("onRequest", async (request) => {
      request.session = {
        id: "00000000-0000-4000-8000-000000000003",
        kind: "WEB",
        accountId: "00000000-0000-4000-8000-000000000004",
        participantId: null,
        expiresAt: new Date("2027-01-01T00:00:00Z"),
      };
    });
    await registerRoutes(app, {
      store,
      redis: { eval: vi.fn().mockResolvedValue(1) } as unknown as Redis,
      config,
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/matches",
      payload: { ...createInput, telegramChatId: "123456" },
    });

    expect(response.statusCode).toBe(400);
    expect(createMatch).not.toHaveBeenCalled();
    await app.close();
  });

  it("does not let a Telegram account claim an unsigned chat", async () => {
    const createMatch = vi.fn().mockResolvedValue({
      matchId: "00000000-0000-4000-8000-000000000001",
      participantId: "00000000-0000-4000-8000-000000000002",
      inviteCode: "invite-code",
    });
    const store = { createMatch } as unknown as GameStore;
    const app = Fastify({ logger: false });
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    app.decorateRequest("session", null);
    app.addHook("onRequest", async (request) => {
      request.session = {
        id: "00000000-0000-4000-8000-000000000003",
        kind: "TELEGRAM",
        accountId: "00000000-0000-4000-8000-000000000004",
        participantId: null,
        expiresAt: new Date("2027-01-01T00:00:00Z"),
      };
    });
    await registerRoutes(app, {
      store,
      redis: { eval: vi.fn().mockResolvedValue(1) } as unknown as Redis,
      config,
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/matches",
      payload: { ...createInput, telegramChatId: "123456" },
    });

    expect(response.statusCode).toBe(400);
    expect(createMatch).not.toHaveBeenCalled();
    await app.close();
  });

  it("allows the signed Telegram user to consume a fresh chat grant", async () => {
    const createMatch = vi.fn().mockResolvedValue({
      matchId: "00000000-0000-4000-8000-000000000001",
      participantId: "00000000-0000-4000-8000-000000000002",
      inviteCode: "invite-code",
    });
    const getAccount = vi.fn().mockResolvedValue({
      id: "00000000-0000-4000-8000-000000000004",
      telegramUserId: "42",
      displayName: "Telegram Host",
    });
    const store = { createMatch, getAccount } as unknown as GameStore;
    const consumeGrant = vi.fn().mockResolvedValue("OK");
    const redis = {
      eval: vi.fn().mockResolvedValue(1),
      set: consumeGrant,
    } as unknown as Redis;
    const app = Fastify({ logger: false });
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    app.decorateRequest("session", null);
    app.addHook("onRequest", async (request) => {
      request.session = {
        id: "00000000-0000-4000-8000-000000000003",
        kind: "TELEGRAM",
        accountId: "00000000-0000-4000-8000-000000000004",
        participantId: null,
        expiresAt: new Date("2027-01-01T00:00:00Z"),
      };
    });
    await registerRoutes(app, { store, redis, config });
    const telegramChatProofIssuedAt = Math.floor(Date.now() / 1000);
    const telegramChatProof = createHmac("sha256", config.BOT_SERVICE_TOKEN)
      .update(`123456\n42\n${telegramChatProofIssuedAt}`)
      .digest("hex");

    const response = await app.inject({
      method: "POST",
      url: "/v1/matches",
      payload: {
        ...createInput,
        telegramChatId: "123456",
        telegramUserId: "42",
        telegramChatProofIssuedAt,
        telegramChatProof,
      },
    });

    expect(response.statusCode).toBe(201);
    expect(createMatch).toHaveBeenCalledOnce();
    expect(consumeGrant).toHaveBeenCalledWith(
      expect.stringContaining("chat-grant:"),
      "1",
      "EX",
      300,
      "NX",
    );
    await app.close();
  });

  it("replaces a guest identity in the same operation as the new join", async () => {
    const joinGuestSession = vi.fn().mockResolvedValue({
      participantId: "00000000-0000-4000-8000-000000000005",
      matchId: "00000000-0000-4000-8000-000000000006",
      token: "new-session-token",
      expiresAt: new Date("2027-01-01T00:00:00Z"),
    });
    const store = { joinGuestSession } as unknown as GameStore;
    const app = Fastify({ logger: false });
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app.register(cookie);
    app.decorateRequest("session", null);
    app.addHook("onRequest", async (request) => {
      request.session = {
        id: "00000000-0000-4000-8000-000000000003",
        kind: "GUEST",
        accountId: null,
        participantId: "00000000-0000-4000-8000-000000000004",
        expiresAt: new Date("2027-01-01T00:00:00Z"),
      };
    });
    await registerRoutes(app, {
      store,
      redis: { eval: vi.fn().mockResolvedValue(1) } as unknown as Redis,
      config,
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/auth/guest",
      headers: { cookie: "geohunter_session=old-session-token" },
      payload: {
        inviteCode: "invite-code",
        displayName: "Guest Player",
        consentLocation: true,
        consentReplay: true,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(joinGuestSession).toHaveBeenCalledWith(
      "invite-code",
      "Guest Player",
      30,
      {
        id: "00000000-0000-4000-8000-000000000003",
        token: "old-session-token",
      },
    );
    expect(response.headers["set-cookie"]).toContain(
      "geohunter_session=new-session-token",
    );
    await app.close();
  });

  it("deletes the authenticated identity and clears its cookie", async () => {
    const deleteIdentity = vi.fn().mockResolvedValue({
      matchIds: [],
      participantIds: [],
    });
    const store = { deleteIdentity } as unknown as GameStore;
    const app = Fastify({ logger: false });
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app.register(cookie);
    app.decorateRequest("session", null);
    app.addHook("onRequest", async (request) => {
      request.session = {
        id: "00000000-0000-4000-8000-000000000003",
        kind: "WEB",
        accountId: "00000000-0000-4000-8000-000000000004",
        participantId: null,
        expiresAt: new Date("2030-01-01T00:00:00.000Z"),
      };
    });
    await registerRoutes(app, {
      store,
      redis: { eval: vi.fn().mockResolvedValue(1) } as unknown as Redis,
      config,
    });

    const response = await app.inject({
      method: "DELETE",
      url: "/v1/account",
      headers: { cookie: "geohunter_session=session-token" },
    });

    expect(response.statusCode).toBe(204);
    expect(deleteIdentity).toHaveBeenCalledTimes(1);
    expect(response.headers["set-cookie"]).toContain("Max-Age=0");
    await app.close();
  });

  it("purges deleted matches, viewers, and targets from location caches", async () => {
    const redis = {
      scan: vi.fn().mockResolvedValue([
        "0",
        [
          "revealed:hosted:viewer",
          "revealed:other:deleted-player",
          "revealed:other:another-viewer",
        ],
      ]),
      del: vi.fn().mockResolvedValue(1),
      hdel: vi.fn().mockResolvedValue(1),
    } as unknown as Redis;

    await purgeRevealedLocations(redis, {
      matchIds: ["hosted"],
      participantIds: ["deleted-player"],
    });

    expect(redis.del).toHaveBeenCalledWith("revealed:hosted:viewer");
    expect(redis.del).toHaveBeenCalledWith("revealed:other:deleted-player");
    expect(redis.hdel).toHaveBeenCalledWith(
      "revealed:other:another-viewer",
      "deleted-player",
    );
  });

  it("rate-limits browser account creation by client address", async () => {
    const createWebAccount = vi.fn();
    const redis = { eval: vi.fn().mockResolvedValue(6) } as unknown as Redis;
    const store = { createWebAccount } as unknown as GameStore;
    const app = Fastify({ logger: false });
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app.register(cookie);
    app.decorateRequest("session", null);
    await registerRoutes(app, { store, redis, config });

    const response = await app.inject({
      method: "POST",
      url: "/v1/auth/web",
      payload: { displayName: "Contest Judge" },
    });

    expect(response.statusCode).toBe(429);
    expect(createWebAccount).not.toHaveBeenCalled();
    await app.close();
  });

  it("does not expose unexpected store errors", async () => {
    const createWebAccount = vi
      .fn()
      .mockRejectedValue(
        new Error("database connection included private details"),
      );
    const store = { createWebAccount } as unknown as GameStore;
    const app = Fastify({ logger: false });
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app.register(cookie);
    app.decorateRequest("session", null);
    await registerRoutes(app, {
      store,
      redis: { eval: vi.fn().mockResolvedValue(1) } as unknown as Redis,
      config,
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/auth/web",
      payload: { displayName: "Contest Judge" },
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      error: "INTERNAL_ERROR",
      message: "Unexpected server error",
    });
    expect(response.body).not.toContain("private details");
    await app.close();
  });

  it("creates a cookie-backed browser account without Telegram", async () => {
    const createWebAccount = vi.fn().mockResolvedValue({
      id: "00000000-0000-4000-8000-000000000004",
      displayName: "Browser Host",
    });
    const createSession = vi.fn().mockResolvedValue({
      token: "opaque-session-token",
      expiresAt: new Date("2027-01-01T00:00:00Z"),
    });
    const store = {
      createWebAccount,
      createSession,
    } as unknown as GameStore;
    const app = Fastify({ logger: false });
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app.register(cookie);
    app.decorateRequest("session", null);
    app.addHook("onRequest", async (request) => {
      request.session = {
        id: "00000000-0000-4000-8000-000000000003",
        kind: "GUEST",
        accountId: null,
        participantId: "00000000-0000-4000-8000-000000000005",
        expiresAt: new Date("2027-01-01T00:00:00Z"),
      };
    });
    const redis = { eval: vi.fn().mockResolvedValue(1) } as unknown as Redis;
    await registerRoutes(app, { store, redis, config });

    const response = await app.inject({
      method: "POST",
      url: "/v1/auth/web",
      headers: { cookie: "geohunter_session=old-guest-token" },
      payload: { displayName: "  Browser Host  " },
    });

    expect(response.statusCode).toBe(200);
    expect(createWebAccount).toHaveBeenCalledWith("Browser Host");
    expect(createSession).toHaveBeenCalledWith(
      {
        kind: "WEB",
        accountId: "00000000-0000-4000-8000-000000000004",
        days: 30,
      },
      {
        id: "00000000-0000-4000-8000-000000000003",
        token: "old-guest-token",
      },
    );
    expect(response.headers["set-cookie"]).toContain(
      "geohunter_session=opaque-session-token",
    );
    expect(response.json()).toEqual({
      account: {
        id: "00000000-0000-4000-8000-000000000004",
        displayName: "Browser Host",
      },
      kind: "WEB",
    });
    await app.close();
  });
});

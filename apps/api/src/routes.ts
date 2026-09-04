import {
  AssignRoleSchema,
  CreateMatchSchema,
  GuestAuthSchema,
  JoinMatchSchema,
  MatchActionSchema,
  ModerationActionSchema,
  TelegramAuthSchema,
  UpdateMatchSchema,
} from "@geohunter/contracts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import type { Redis } from "ioredis";
import { z, ZodError } from "zod";
import type { ApiConfig } from "./config.js";
import { validateTelegramInitData } from "./security.js";
import { buildSnapshot } from "./snapshot.js";
import type { GameStore, SessionContext } from "./store.js";

const IdParameters = z.object({ id: z.uuid() });
const RoleParameters = z.object({ id: z.uuid(), participantId: z.uuid() });
const InviteParameters = z.object({ code: z.string().min(8).max(128) });
const PublishBody = z.object({ published: z.boolean() });
const DevAuthBody = z.object({ displayName: z.string().trim().min(2).max(40) });
const TelegramIdParameters = z.object({ telegramId: z.string().regex(/^\d+$/) });
const TelegramMatchParameters = z.object({ telegramId: z.string().regex(/^\d+$/), id: z.uuid() });

class ApiError extends Error {
  constructor(public readonly statusCode: number, message: string) {
    super(message);
  }
}

function requireSession(request: FastifyRequest): SessionContext {
  if (!request.session) throw new ApiError(401, "Authentication required");
  return request.session;
}

function setSessionCookie(reply: FastifyReply, config: ApiConfig, token: string, expiresAt: Date) {
  reply.setCookie(config.SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    secure: config.COOKIE_SECURE,
    sameSite: config.COOKIE_SECURE ? "none" : "lax",
    path: "/",
    expires: expiresAt,
  });
}

export async function registerRoutes(app: FastifyInstance, dependencies: { store: GameStore; redis: Redis; config: ApiConfig }) {
  const { store, redis, config } = dependencies;
  const api = app.withTypeProvider<ZodTypeProvider>();

  api.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) return reply.code(400).send({ error: "VALIDATION_ERROR", details: error.issues });
    if (error instanceof ApiError) return reply.code(error.statusCode).send({ error: "REQUEST_REJECTED", message: error.message });
    const message = error instanceof Error ? error.message : "Unknown error";
    const status = /required|access|authentication/i.test(message) ? 403 : /not found|missing/i.test(message) ? 404 : 400;
    return reply.code(status).send({ error: "REQUEST_REJECTED", message });
  });

  api.get("/health", { schema: { tags: ["system"] } }, async () => ({ ok: true, service: "geohunter-api" }));
  api.get("/ready", { schema: { tags: ["system"] } }, async (_request, reply) => {
    await store.ping();
    await redis.ping();
    return reply.send({ ok: true });
  });

  api.post("/v1/auth/telegram", { schema: { body: TelegramAuthSchema, tags: ["auth"] } }, async (request, reply) => {
    const body = TelegramAuthSchema.parse(request.body);
    const user = validateTelegramInitData(body.initData, config.BOT_TOKEN, config.TELEGRAM_AUTH_MAX_AGE_SECONDS);
    const account = await store.upsertTelegramAccount(user);
    const session = await store.createSession({ kind: "TELEGRAM", accountId: account.id, days: config.SESSION_DAYS });
    setSessionCookie(reply, config, session.token, session.expiresAt);
    return { account, kind: "TELEGRAM" };
  });

  api.post("/v1/auth/dev", { schema: { body: DevAuthBody, tags: ["auth"] } }, async (request, reply) => {
    if (!config.DEV_AUTH_ENABLED || config.NODE_ENV === "production") throw new ApiError(404, "Development authentication disabled");
    const body = DevAuthBody.parse(request.body);
    const account = await store.createDevAccount(body.displayName);
    const session = await store.createSession({ kind: "TELEGRAM", accountId: account.id, days: 1 });
    setSessionCookie(reply, config, session.token, session.expiresAt);
    return { account, kind: "TELEGRAM", development: true };
  });

  api.post("/v1/auth/guest", { schema: { body: GuestAuthSchema, tags: ["auth"] } }, async (request, reply) => {
    const body = GuestAuthSchema.parse(request.body);
    const joined = await store.joinGuest(body.inviteCode, body.displayName);
    const session = await store.createSession({ kind: "GUEST", participantId: joined.participantId, days: config.SESSION_DAYS });
    setSessionCookie(reply, config, session.token, session.expiresAt);
    return joined;
  });

  api.post("/v1/auth/logout", { schema: { tags: ["auth"] } }, async (request, reply) => {
    const token = request.cookies[config.SESSION_COOKIE_NAME];
    if (token) await store.revokeSession(token);
    reply.clearCookie(config.SESSION_COOKIE_NAME, { path: "/" });
    return reply.code(204).send();
  });

  api.get("/v1/auth/me", { schema: { tags: ["auth"] } }, async (request) => {
    const session = requireSession(request);
    return {
      kind: session.kind,
      account: session.accountId ? await store.getAccount(session.accountId) : null,
      participantId: session.participantId,
    };
  });

  api.get("/v1/invites/:code", { schema: { params: InviteParameters, tags: ["matches"] } }, async (request) => {
    const { code } = InviteParameters.parse(request.params);
    const preview = await store.getInvitePreview(code);
    if (!preview) throw new ApiError(404, "Invite not found");
    return preview;
  });

  api.post("/v1/matches/join", { schema: { body: JoinMatchSchema, tags: ["matches"] } }, async (request) => {
    const session = requireSession(request);
    if (!session.accountId) throw new ApiError(403, "Telegram authentication required");
    const { inviteCode } = JoinMatchSchema.parse(request.body);
    return store.joinTelegram(inviteCode, session.accountId);
  });

  api.get("/v1/matches", { schema: { tags: ["matches"] } }, async (request) => {
    const session = requireSession(request);
    if (!session.accountId) return [];
    return store.listMatches(session.accountId);
  });

  api.post("/v1/matches", { schema: { body: CreateMatchSchema, tags: ["matches"] } }, async (request, reply) => {
    const session = requireSession(request);
    if (!session.accountId || session.kind !== "TELEGRAM") throw new ApiError(403, "Telegram host authentication required");
    const result = await store.createMatch(session.accountId, CreateMatchSchema.parse(request.body));
    return reply.code(201).send({ ...result, inviteUrl: `${config.PUBLIC_WEBAPP_URL}/?invite=${encodeURIComponent(result.inviteCode)}` });
  });

  api.get("/v1/matches/:id", { schema: { params: IdParameters, tags: ["matches"] } }, async (request) => {
    const session = requireSession(request);
    const { id } = IdParameters.parse(request.params);
    const viewer = await store.getViewer(id, session);
    if (!viewer) throw new ApiError(403, "Match participant access required");
    return buildSnapshot(store, redis, id, viewer);
  });

  api.patch("/v1/matches/:id", { schema: { params: IdParameters, body: UpdateMatchSchema, tags: ["matches"] } }, async (request) => {
    const session = requireSession(request);
    const { id } = IdParameters.parse(request.params);
    await store.assertHost(id, session.accountId);
    await store.updateMatch(id, UpdateMatchSchema.parse(request.body));
    return { ok: true };
  });

  api.post("/v1/matches/:id/invite", { schema: { params: IdParameters, tags: ["matches"] } }, async (request) => {
    const session = requireSession(request);
    const { id } = IdParameters.parse(request.params);
    await store.assertHost(id, session.accountId);
    const inviteCode = await store.rotateInvite(id);
    return { inviteCode, inviteUrl: `${config.PUBLIC_WEBAPP_URL}/?invite=${encodeURIComponent(inviteCode)}` };
  });

  api.put("/v1/matches/:id/participants/:participantId/role", { schema: { params: RoleParameters, body: AssignRoleSchema, tags: ["matches"] } }, async (request) => {
    const session = requireSession(request);
    const { id, participantId } = RoleParameters.parse(request.params);
    await store.assertHost(id, session.accountId);
    const { role } = AssignRoleSchema.parse(request.body);
    await store.assignRole(id, participantId, role);
    return { ok: true };
  });

  api.post("/v1/matches/:id/participants/balance", { schema: { params: IdParameters, tags: ["matches"] } }, async (request) => {
    const session = requireSession(request);
    const { id } = IdParameters.parse(request.params);
    await store.assertHost(id, session.accountId);
    await store.autoBalance(id);
    return { ok: true };
  });

  api.post("/v1/matches/:id/participants/:participantId/moderation", { schema: { params: RoleParameters, body: ModerationActionSchema, tags: ["matches"] } }, async (request) => {
    const session = requireSession(request);
    const { id, participantId } = RoleParameters.parse(request.params);
    await store.assertHost(id, session.accountId);
    const { action } = ModerationActionSchema.parse(request.body);
    await store.moderateParticipant(id, participantId, action);
    return { ok: true };
  });

  api.post("/v1/matches/:id/actions", { schema: { params: IdParameters, body: MatchActionSchema, tags: ["game"] } }, async (request) => {
    const session = requireSession(request);
    const { id } = IdParameters.parse(request.params);
    await store.assertHost(id, session.accountId);
    const viewer = await store.getViewer(id, session);
    if (!viewer) throw new ApiError(403, "Host participant missing");
    const { action } = MatchActionSchema.parse(request.body);
    const state = await store.performAction(id, viewer.participantId, action);
    return { state };
  });

  api.put("/v1/matches/:id/replay/publication", { schema: { params: IdParameters, body: PublishBody, tags: ["replay"] } }, async (request) => {
    const session = requireSession(request);
    const { id } = IdParameters.parse(request.params);
    await store.assertHost(id, session.accountId);
    const { published } = PublishBody.parse(request.body);
    await store.setReplayPublished(id, session.accountId!, published);
    return { published };
  });

  api.get("/v1/matches/:id/replay", { schema: { params: IdParameters, tags: ["replay"] } }, async (request) => {
    const session = requireSession(request);
    const { id } = IdParameters.parse(request.params);
    if (!(await store.mayViewReplay(id, session))) throw new ApiError(403, "Replay is not published");
    return store.getReplay(id);
  });

  api.get("/v1/matches/:id/export", { schema: { params: IdParameters, tags: ["replay"] } }, async (request, reply) => {
    const session = requireSession(request);
    const { id } = IdParameters.parse(request.params);
    await store.assertHost(id, session.accountId);
    const replay = await store.getReplay(id);
    reply.header("content-disposition", `attachment; filename=geohunter-${id}.json`);
    return replay;
  });

  api.delete("/v1/matches/:id", { schema: { params: IdParameters, tags: ["matches"] } }, async (request, reply) => {
    const session = requireSession(request);
    const { id } = IdParameters.parse(request.params);
    await store.assertHost(id, session.accountId);
    await store.deleteMatch(id);
    return reply.code(204).send();
  });

  api.get("/internal/telegram/:telegramId/matches", { schema: { params: TelegramIdParameters, tags: ["internal"] } }, async (request) => {
    if (request.headers["x-bot-service-token"] !== config.BOT_SERVICE_TOKEN) throw new ApiError(403, "Bot service access required");
    const { telegramId } = TelegramIdParameters.parse(request.params);
    return store.listMatchesByTelegramId(telegramId);
  });

  api.post("/internal/telegram/:telegramId/matches/:id/actions", { schema: { params: TelegramMatchParameters, body: MatchActionSchema, tags: ["internal"] } }, async (request) => {
    if (request.headers["x-bot-service-token"] !== config.BOT_SERVICE_TOKEN) throw new ApiError(403, "Bot service access required");
    const { telegramId, id } = TelegramMatchParameters.parse(request.params);
    const { action } = MatchActionSchema.parse(request.body);
    return { state: await store.performTelegramHostAction(telegramId, id, action) };
  });

  api.post("/internal/telegram/:telegramId/matches/:id/invite", { schema: { params: TelegramMatchParameters, tags: ["internal"] } }, async (request) => {
    if (request.headers["x-bot-service-token"] !== config.BOT_SERVICE_TOKEN) throw new ApiError(403, "Bot service access required");
    const { telegramId, id } = TelegramMatchParameters.parse(request.params);
    const inviteCode = await store.rotateTelegramHostInvite(telegramId, id);
    return { inviteCode, inviteUrl: `${config.PUBLIC_WEBAPP_URL}/?invite=${encodeURIComponent(inviteCode)}` };
  });
}

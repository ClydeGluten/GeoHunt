import {
  AssignRoleSchema,
  CreateMatchSchema,
  GuestAuthSchema,
  JoinMatchSchema,
  MatchActionSchema,
  ModerationActionSchema,
  TelegramAuthSchema,
  UpdateMatchSchema,
  WebAuthSchema,
} from "@geohunter/contracts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import type { Redis } from "ioredis";
import { z, ZodError } from "zod";
import type { ApiConfig } from "./config.js";
import {
  validateTelegramInitData,
  verifyTelegramChatProof,
} from "./security.js";
import { buildSnapshot } from "./snapshot.js";
import type { DeletionScope, GameStore, SessionContext } from "./store.js";

const IdParameters = z.object({ id: z.uuid() });
const RoleParameters = z.object({ id: z.uuid(), participantId: z.uuid() });
const InviteParameters = z.object({ code: z.string().min(8).max(128) });
const PublishBody = z.object({ published: z.boolean() });
const DevAuthBody = z.object({ displayName: z.string().trim().min(2).max(40) });
const TelegramIdParameters = z.object({
  telegramId: z.string().regex(/^\d+$/),
});
const TelegramMatchParameters = z.object({
  telegramId: z.string().regex(/^\d+$/),
  id: z.uuid(),
});

class ApiError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

const publicStoreErrors: Array<[RegExp, number]> = [
  [/^(Host account authentication|Host access) required$/, 403],
  [/^Open the Mini App once to link your Telegram account$/, 403],
  [/^(Account|Host participant|Match|Playzone) (missing|not found)$/, 404],
  [
    /^(Previous session was already replaced|Invite is invalid or match already started|Only draft or lobby matches can be edited|Roles can only be assigned in the lobby|Role cannot be assigned|Roles can only be balanced before the match starts|At least two players are required to balance roles|Participant cannot be moderated|Match needs at least one hider and one seeker|Match is not paused|Match already closed|Only a finished match replay can be published|Replay is available only after the match finishes)$/,
    400,
  ],
  [
    /^Telegram (hash missing or malformed|signature invalid|auth_date missing|authentication expired|user missing|user malformed)$/,
    400,
  ],
];

function publicStoreError(message: string): number | null {
  return (
    publicStoreErrors.find(([pattern]) => pattern.test(message))?.[1] ?? null
  );
}

function validationIssues(error: unknown): unknown[] | null {
  if (error instanceof ZodError) return error.issues;
  if (
    error instanceof Error &&
    error.name === "ZodError" &&
    "issues" in error &&
    Array.isArray(error.issues)
  )
    return error.issues;
  if (
    typeof error === "object" &&
    error !== null &&
    "validation" in error &&
    Array.isArray(error.validation)
  )
    return error.validation;
  return null;
}

export async function purgeRevealedLocations(
  redis: Redis,
  scope: DeletionScope,
): Promise<void> {
  if (scope.matchIds.length === 0 && scope.participantIds.length === 0) return;
  const matchIds = new Set(scope.matchIds);
  const participantIds = new Set(scope.participantIds);
  let cursor = "0";
  do {
    const [nextCursor, keys] = await redis.scan(
      cursor,
      "MATCH",
      "revealed:*",
      "COUNT",
      100,
    );
    cursor = nextCursor;
    for (const key of keys) {
      const [, matchId, viewerId] = key.split(":");
      if (
        (matchId && matchIds.has(matchId)) ||
        (viewerId && participantIds.has(viewerId))
      ) {
        await redis.del(key);
      } else if (scope.participantIds.length > 0) {
        await redis.hdel(key, ...scope.participantIds);
      }
    }
  } while (cursor !== "0");
}

async function enforceRateLimit(
  redis: Redis,
  key: string,
  limit: number,
  windowSeconds: number,
): Promise<void> {
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
  if (Number(count) > limit) throw new ApiError(429, "Too many requests");
}

function requireSession(request: FastifyRequest): SessionContext {
  if (!request.session) throw new ApiError(401, "Authentication required");
  return request.session;
}

function setSessionCookie(
  reply: FastifyReply,
  config: ApiConfig,
  token: string,
  expiresAt: Date,
) {
  reply.setCookie(config.SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    secure: config.COOKIE_SECURE,
    sameSite: config.COOKIE_SECURE ? "none" : "lax",
    path: "/",
    expires: expiresAt,
  });
}

export async function registerRoutes(
  app: FastifyInstance,
  dependencies: { store: GameStore; redis: Redis; config: ApiConfig },
) {
  const { store, redis, config } = dependencies;
  const api = app.withTypeProvider<ZodTypeProvider>();
  const previousSession = (request: FastifyRequest) => {
    const token = request.cookies[config.SESSION_COOKIE_NAME];
    return token && request.session
      ? { id: request.session.id, token }
      : undefined;
  };

  api.setErrorHandler((error, request, reply) => {
    const issues = validationIssues(error);
    if (issues)
      return reply
        .code(400)
        .send({ error: "VALIDATION_ERROR", details: issues });
    if (error instanceof ApiError)
      return reply
        .code(error.statusCode)
        .send({ error: "REQUEST_REJECTED", message: error.message });
    const message = error instanceof Error ? error.message : "Unknown error";
    const status = publicStoreError(message);
    if (status !== null)
      return reply.code(status).send({ error: "REQUEST_REJECTED", message });
    request.log.error({ err: error }, "Unhandled API route error");
    return reply
      .code(500)
      .send({ error: "INTERNAL_ERROR", message: "Unexpected server error" });
  });

  api.get("/health", { schema: { tags: ["system"] } }, async () => ({
    ok: true,
    service: "geohunter-api",
  }));
  api.get(
    "/ready",
    { schema: { tags: ["system"] } },
    async (_request, reply) => {
      await store.ping();
      await redis.ping();
      return reply.send({ ok: true });
    },
  );

  api.post(
    "/v1/auth/telegram",
    { schema: { body: TelegramAuthSchema, tags: ["auth"] } },
    async (request, reply) => {
      await enforceRateLimit(
        redis,
        `rate:http:auth-telegram:${request.ip}`,
        20,
        60,
      );
      const body = TelegramAuthSchema.parse(request.body);
      const user = validateTelegramInitData(
        body.initData,
        config.BOT_TOKEN,
        config.TELEGRAM_AUTH_MAX_AGE_SECONDS,
      );
      const account = await store.upsertTelegramAccount(user);
      const session = await store.createSession(
        {
          kind: "TELEGRAM",
          accountId: account.id,
          days: config.SESSION_DAYS,
        },
        previousSession(request),
      );
      setSessionCookie(reply, config, session.token, session.expiresAt);
      return { account, kind: "TELEGRAM" };
    },
  );

  api.post(
    "/v1/auth/dev",
    { schema: { body: DevAuthBody, tags: ["auth"] } },
    async (request, reply) => {
      if (!config.DEV_AUTH_ENABLED || config.NODE_ENV === "production")
        throw new ApiError(404, "Development authentication disabled");
      await enforceRateLimit(redis, `rate:http:auth-dev:${request.ip}`, 10, 60);
      const body = DevAuthBody.parse(request.body);
      const account = await store.createDevAccount(body.displayName);
      const session = await store.createSession(
        {
          kind: "TELEGRAM",
          accountId: account.id,
          days: 1,
        },
        previousSession(request),
      );
      setSessionCookie(reply, config, session.token, session.expiresAt);
      return { account, kind: "TELEGRAM", development: true };
    },
  );

  api.post(
    "/v1/auth/web",
    { schema: { body: WebAuthSchema, tags: ["auth"] } },
    async (request, reply) => {
      await enforceRateLimit(redis, `rate:http:auth-web:${request.ip}`, 5, 60);
      const { displayName } = WebAuthSchema.parse(request.body);
      const account = await store.createWebAccount(displayName);
      const session = await store.createSession(
        {
          kind: "WEB",
          accountId: account.id,
          days: config.SESSION_DAYS,
        },
        previousSession(request),
      );
      setSessionCookie(reply, config, session.token, session.expiresAt);
      return { account, kind: "WEB" };
    },
  );

  api.post(
    "/v1/auth/guest",
    { schema: { body: GuestAuthSchema, tags: ["auth"] } },
    async (request, reply) => {
      await enforceRateLimit(
        redis,
        `rate:http:auth-guest:${request.ip}`,
        10,
        60,
      );
      const body = GuestAuthSchema.parse(request.body);
      const joined = await store.joinGuestSession(
        body.inviteCode,
        body.displayName,
        config.SESSION_DAYS,
        previousSession(request),
      );
      setSessionCookie(reply, config, joined.token, joined.expiresAt);
      return { participantId: joined.participantId, matchId: joined.matchId };
    },
  );

  api.post(
    "/v1/auth/logout",
    { schema: { tags: ["auth"] } },
    async (request, reply) => {
      const token = request.cookies[config.SESSION_COOKIE_NAME];
      if (token) await store.revokeSession(token);
      reply.clearCookie(config.SESSION_COOKIE_NAME, { path: "/" });
      return reply.code(204).send();
    },
  );

  api.delete(
    "/v1/account",
    { schema: { tags: ["auth"] } },
    async (request, reply) => {
      const session = requireSession(request);
      const scope = await store.deleteIdentity(session);
      await purgeRevealedLocations(redis, scope);
      reply.clearCookie(config.SESSION_COOKIE_NAME, { path: "/" });
      return reply.code(204).send();
    },
  );

  api.get("/v1/auth/me", { schema: { tags: ["auth"] } }, async (request) => {
    const session = requireSession(request);
    return {
      kind: session.kind,
      account: session.accountId
        ? await store.getAccount(session.accountId)
        : null,
      participantId: session.participantId,
    };
  });

  api.get(
    "/v1/invites/:code",
    { schema: { params: InviteParameters, tags: ["matches"] } },
    async (request) => {
      await enforceRateLimit(
        redis,
        `rate:http:invite-preview:${request.ip}`,
        60,
        60,
      );
      const { code } = InviteParameters.parse(request.params);
      const preview = await store.getInvitePreview(code);
      if (!preview) throw new ApiError(404, "Invite not found");
      return preview;
    },
  );

  api.post(
    "/v1/matches/join",
    { schema: { body: JoinMatchSchema, tags: ["matches"] } },
    async (request) => {
      const session = requireSession(request);
      if (!session.accountId)
        throw new ApiError(403, "Account authentication required");
      await enforceRateLimit(
        redis,
        `rate:http:join:${session.accountId}`,
        20,
        60,
      );
      const { inviteCode } = JoinMatchSchema.parse(request.body);
      return store.joinAccount(inviteCode, session.accountId);
    },
  );

  api.get("/v1/matches", { schema: { tags: ["matches"] } }, async (request) => {
    const session = requireSession(request);
    if (!session.accountId) return [];
    return store.listMatches(session.accountId);
  });

  api.post(
    "/v1/matches",
    { schema: { body: CreateMatchSchema, tags: ["matches"] } },
    async (request, reply) => {
      const session = requireSession(request);
      if (!session.accountId)
        throw new ApiError(403, "Host account authentication required");
      await enforceRateLimit(
        redis,
        `rate:http:create-match:${session.accountId}`,
        10,
        60,
      );
      const input = CreateMatchSchema.parse(request.body);
      if (input.telegramChatId != null) {
        if (
          session.kind !== "TELEGRAM" ||
          !input.telegramUserId ||
          !input.telegramChatProofIssuedAt ||
          !input.telegramChatProof
        ) {
          throw new ApiError(403, "A complete Telegram chat grant is required");
        }
        const account = await store.getAccount(session.accountId);
        if (!account || account.telegramUserId !== input.telegramUserId) {
          throw new ApiError(
            403,
            "Telegram chat grant belongs to another user",
          );
        }
        if (
          !verifyTelegramChatProof(
            input.telegramChatId,
            input.telegramUserId,
            input.telegramChatProofIssuedAt,
            input.telegramChatProof,
            config.BOT_SERVICE_TOKEN,
            300,
          )
        ) {
          throw new ApiError(403, "Invalid or expired Telegram chat grant");
        }
        const consumed = await redis.set(
          `chat-grant:${input.telegramChatProof}`,
          "1",
          "EX",
          300,
          "NX",
        );
        if (consumed !== "OK") {
          throw new ApiError(403, "Telegram chat grant was already used");
        }
      }
      const {
        telegramChatProof: _telegramChatProof,
        telegramChatProofIssuedAt: _telegramChatProofIssuedAt,
        telegramUserId: _telegramUserId,
        ...matchInput
      } = input;
      const result = await store.createMatch(session.accountId, matchInput);
      return reply.code(201).send({
        ...result,
        inviteUrl: `${config.PUBLIC_WEBAPP_URL}/?invite=${encodeURIComponent(result.inviteCode)}`,
      });
    },
  );

  api.get(
    "/v1/matches/:id",
    { schema: { params: IdParameters, tags: ["matches"] } },
    async (request) => {
      const session = requireSession(request);
      const { id } = IdParameters.parse(request.params);
      const viewer = await store.getViewer(id, session);
      if (!viewer) throw new ApiError(403, "Match participant access required");
      return buildSnapshot(store, redis, id, viewer);
    },
  );

  api.patch(
    "/v1/matches/:id",
    {
      schema: {
        params: IdParameters,
        body: UpdateMatchSchema,
        tags: ["matches"],
      },
    },
    async (request) => {
      const session = requireSession(request);
      const { id } = IdParameters.parse(request.params);
      await store.assertHost(id, session.accountId);
      await store.updateMatch(id, UpdateMatchSchema.parse(request.body));
      return { ok: true };
    },
  );

  api.post(
    "/v1/matches/:id/invite",
    { schema: { params: IdParameters, tags: ["matches"] } },
    async (request) => {
      const session = requireSession(request);
      const { id } = IdParameters.parse(request.params);
      await store.assertHost(id, session.accountId);
      const inviteCode = await store.rotateInvite(id);
      return {
        inviteCode,
        inviteUrl: `${config.PUBLIC_WEBAPP_URL}/?invite=${encodeURIComponent(inviteCode)}`,
      };
    },
  );

  api.put(
    "/v1/matches/:id/participants/:participantId/role",
    {
      schema: {
        params: RoleParameters,
        body: AssignRoleSchema,
        tags: ["matches"],
      },
    },
    async (request) => {
      const session = requireSession(request);
      const { id, participantId } = RoleParameters.parse(request.params);
      await store.assertHost(id, session.accountId);
      const { role } = AssignRoleSchema.parse(request.body);
      await store.assignRole(id, participantId, role);
      return { ok: true };
    },
  );

  api.post(
    "/v1/matches/:id/participants/balance",
    { schema: { params: IdParameters, tags: ["matches"] } },
    async (request) => {
      const session = requireSession(request);
      const { id } = IdParameters.parse(request.params);
      await store.assertHost(id, session.accountId);
      await store.autoBalance(id);
      return { ok: true };
    },
  );

  api.post(
    "/v1/matches/:id/participants/:participantId/moderation",
    {
      schema: {
        params: RoleParameters,
        body: ModerationActionSchema,
        tags: ["matches"],
      },
    },
    async (request) => {
      const session = requireSession(request);
      const { id, participantId } = RoleParameters.parse(request.params);
      await store.assertHost(id, session.accountId);
      const { action } = ModerationActionSchema.parse(request.body);
      await store.moderateParticipant(id, participantId, action);
      return { ok: true };
    },
  );

  api.post(
    "/v1/matches/:id/actions",
    {
      schema: { params: IdParameters, body: MatchActionSchema, tags: ["game"] },
    },
    async (request) => {
      const session = requireSession(request);
      const { id } = IdParameters.parse(request.params);
      await store.assertHost(id, session.accountId);
      const viewer = await store.getViewer(id, session);
      if (!viewer) throw new ApiError(403, "Host participant missing");
      const { action } = MatchActionSchema.parse(request.body);
      const state = await store.performAction(id, viewer.participantId, action);
      return { state };
    },
  );

  api.put(
    "/v1/matches/:id/replay/publication",
    { schema: { params: IdParameters, body: PublishBody, tags: ["replay"] } },
    async (request) => {
      const session = requireSession(request);
      const { id } = IdParameters.parse(request.params);
      await store.assertHost(id, session.accountId);
      const { published } = PublishBody.parse(request.body);
      await store.setReplayPublished(id, session.accountId!, published);
      return { published };
    },
  );

  api.get(
    "/v1/matches/:id/replay",
    { schema: { params: IdParameters, tags: ["replay"] } },
    async (request) => {
      const session = requireSession(request);
      await enforceRateLimit(
        redis,
        `rate:http:replay:${session.accountId ?? session.participantId ?? session.id}`,
        20,
        60,
      );
      const { id } = IdParameters.parse(request.params);
      if (!(await store.mayViewReplay(id, session)))
        throw new ApiError(403, "Replay is not published");
      return store.getReplay(id);
    },
  );

  api.get(
    "/v1/matches/:id/export",
    { schema: { params: IdParameters, tags: ["replay"] } },
    async (request, reply) => {
      const session = requireSession(request);
      await enforceRateLimit(
        redis,
        `rate:http:export:${session.accountId ?? session.participantId ?? session.id}`,
        5,
        60,
      );
      const { id } = IdParameters.parse(request.params);
      await store.assertHost(id, session.accountId);
      const replay = await store.getReplay(id);
      reply.header(
        "content-disposition",
        `attachment; filename=geohunter-${id}.json`,
      );
      return replay;
    },
  );

  api.delete(
    "/v1/matches/:id",
    { schema: { params: IdParameters, tags: ["matches"] } },
    async (request, reply) => {
      const session = requireSession(request);
      const { id } = IdParameters.parse(request.params);
      await store.assertHost(id, session.accountId);
      await store.deleteMatch(id);
      await purgeRevealedLocations(redis, {
        matchIds: [id],
        participantIds: [],
      });
      return reply.code(204).send();
    },
  );

  api.get(
    "/internal/telegram/:telegramId/matches",
    { schema: { params: TelegramIdParameters, tags: ["internal"] } },
    async (request) => {
      if (request.headers["x-bot-service-token"] !== config.BOT_SERVICE_TOKEN)
        throw new ApiError(403, "Bot service access required");
      const { telegramId } = TelegramIdParameters.parse(request.params);
      return store.listMatchesByTelegramId(telegramId);
    },
  );

  api.post(
    "/internal/telegram/:telegramId/matches/:id/actions",
    {
      schema: {
        params: TelegramMatchParameters,
        body: MatchActionSchema,
        tags: ["internal"],
      },
    },
    async (request) => {
      if (request.headers["x-bot-service-token"] !== config.BOT_SERVICE_TOKEN)
        throw new ApiError(403, "Bot service access required");
      const { telegramId, id } = TelegramMatchParameters.parse(request.params);
      const { action } = MatchActionSchema.parse(request.body);
      return {
        state: await store.performTelegramHostAction(telegramId, id, action),
      };
    },
  );

  api.post(
    "/internal/telegram/:telegramId/matches/:id/invite",
    { schema: { params: TelegramMatchParameters, tags: ["internal"] } },
    async (request) => {
      if (request.headers["x-bot-service-token"] !== config.BOT_SERVICE_TOKEN)
        throw new ApiError(403, "Bot service access required");
      const { telegramId, id } = TelegramMatchParameters.parse(request.params);
      const inviteCode = await store.rotateTelegramHostInvite(telegramId, id);
      return {
        inviteCode,
        inviteUrl: `${config.PUBLIC_WEBAPP_URL}/?invite=${encodeURIComponent(inviteCode)}`,
      };
    },
  );
}

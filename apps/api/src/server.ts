import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import { createDatabase } from "@geohunter/db";
import Fastify from "fastify";
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";
import { Redis } from "ioredis";
import { loadConfig, type ApiConfig } from "./config.js";
import { setupRealtime } from "./realtime.js";
import { registerRoutes } from "./routes.js";
import { GameStore } from "./store.js";

export async function buildServer(config: ApiConfig = loadConfig()) {
  const database = createDatabase(config.DATABASE_URL, { max: 20 });
  const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null, enableReadyCheck: true });
  const redisSubscriber = redis.duplicate({ enableReadyCheck: false });
  const store = new GameStore(database);
  const app = Fastify({
    logger: config.LOG_LEVEL === "silent" ? false : { level: config.LOG_LEVEL },
    trustProxy: true,
    bodyLimit: 128 * 1024,
  });
  redis.on("error", (error) => app.log.error({ err: error }, "Redis command connection failed"));
  redisSubscriber.on("error", (error) => app.log.error({ err: error }, "Redis subscriber connection failed"));

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(cookie);
  await app.register(cors, { origin: config.CORS_ORIGIN.split(","), credentials: true, methods: ["GET", "POST", "PUT", "PATCH", "DELETE"] });
  await app.register(rateLimit, { max: 240, timeWindow: "1 minute", redis, keyGenerator: (request) => request.ip });
  await app.register(swagger, {
    openapi: {
      info: { title: "GeoHunter Zone API", version: "0.1.0" },
      servers: [{ url: "/api" }],
      tags: [
        { name: "auth", description: "Telegram and guest sessions" },
        { name: "matches", description: "Host and lobby operations" },
        { name: "game", description: "Authoritative match actions" },
        { name: "replay", description: "Replay access and publication" },
      ],
    },
    transform: jsonSchemaTransform,
  });
  await app.register(swaggerUi, { routePrefix: "/docs" });

  app.decorateRequest("session", null);
  const allowedOrigins = new Set(config.CORS_ORIGIN.split(",").map((origin) => origin.trim()));
  app.addHook("onRequest", async (request, reply) => {
    const origin = request.headers.origin;
    if (origin && !allowedOrigins.has(origin)) return reply.code(403).send({ error: "ORIGIN_REJECTED" });
    const token = request.cookies[config.SESSION_COOKIE_NAME];
    request.session = token ? await store.getSession(token) : null;
  });

  await app.register(async (api) => registerRoutes(api, { store, redis, config }), { prefix: "/api" });
  const realtime = setupRealtime(app.server, { store, redis, redisSubscriber, config });

  app.addHook("onClose", async () => {
    await realtime.close();
    await Promise.all([redis.quit(), redisSubscriber.quit(), database.close()]);
  });

  return app;
}

if (process.env.NODE_ENV !== "test") {
  const config = loadConfig();
  const app = await buildServer(config);
  await app.listen({ host: config.HOST, port: config.PORT });
}

import type { SessionContext } from "./store.js";

declare module "fastify" {
  interface FastifyRequest {
    session: SessionContext | null;
  }
}

export {};

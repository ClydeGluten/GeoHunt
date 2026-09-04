import { describe, expect, it } from "vitest";
import { loadBotConfig } from "./config.js";

describe("bot production configuration", () => {
  it("rejects built-in development secrets", () => {
    expect(() =>
      loadBotConfig({
        NODE_ENV: "production",
        BOT_TOKEN: "1234567890:production-bot-token",
        BOT_WEBHOOK_SECRET: "development-webhook-secret",
        BOT_SERVICE_TOKEN: "development-service-token",
      }),
    ).toThrow(/must be set in production/i);
  });
});

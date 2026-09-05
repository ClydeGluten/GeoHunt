import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

describe("production configuration", () => {
  it("rejects built-in development service secrets", () => {
    expect(() =>
      loadConfig({
        NODE_ENV: "production",
        DATABASE_URL: "postgres://user:pass@localhost/geohunter",
        REDIS_URL: "redis://localhost:6379",
      }),
    ).toThrow(/BOT_TOKEN|BOT_SERVICE_TOKEN/);
  });

  it("keeps browser-owned games accessible beyond a one-day session", () => {
    const config = loadConfig({
      NODE_ENV: "development",
      DATABASE_URL: "postgres://user:***@localhost/geohunter",
      REDIS_URL: "redis://localhost:6379",
    });

    expect(config.SESSION_DAYS).toBe(30);
    expect(config.DEMO_MODE).toBe(false);
  });

  it("only enables the judge demo when explicitly requested", () => {
    const config = loadConfig({
      NODE_ENV: "development",
      DATABASE_URL: "postgres://user:***@localhost/geohunter",
      REDIS_URL: "redis://localhost:6379",
      DEMO_MODE: "true",
    });

    expect(config.DEMO_MODE).toBe(true);
  });
});

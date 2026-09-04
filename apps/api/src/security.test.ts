import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { validateTelegramInitData } from "./security.js";

function signedInitData(token: string, authDate: number) {
  const parameters = new URLSearchParams({
    auth_date: String(authDate),
    query_id: "test-query",
    signature: "modern-telegram-ed25519-signature",
    user: JSON.stringify({ id: 42, first_name: "Ada", username: "ada" }),
  });
  const check = [...parameters.entries()]
    .sort(([first], [second]) => first.localeCompare(second))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const secret = createHmac("sha256", "WebAppData").update(token).digest();
  parameters.set("hash", createHmac("sha256", secret).update(check).digest("hex"));
  return parameters.toString();
}

describe("Telegram initData validation", () => {
  it("accepts authentic fresh data", () => {
    const now = new Date("2026-08-21T12:00:00.000Z");
    const data = signedInitData("secret-token", Math.floor(now.getTime() / 1000));
    expect(validateTelegramInitData(data, "secret-token", 3600, now)).toMatchObject({ id: 42, first_name: "Ada" });
  });

  it("rejects tampering", () => {
    const now = new Date("2026-08-21T12:00:00.000Z");
    const data = signedInitData("secret-token", Math.floor(now.getTime() / 1000)).replace("Ada", "Eve");
    expect(() => validateTelegramInitData(data, "secret-token", 3600, now)).toThrow("signature invalid");
  });

  it("includes Telegram's Ed25519 signature field in HMAC validation", () => {
    const now = new Date("2026-08-21T12:00:00.000Z");
    const data = signedInitData("secret-token", Math.floor(now.getTime() / 1000)).replace(
      "modern-telegram-ed25519-signature",
      "tampered-ed25519-signature",
    );
    expect(() => validateTelegramInitData(data, "secret-token", 3600, now)).toThrow("signature invalid");
  });

  it("rejects stale identity data", () => {
    const now = new Date("2026-08-21T12:00:00.000Z");
    const data = signedInitData("secret-token", Math.floor(now.getTime() / 1000) - 3601);
    expect(() => validateTelegramInitData(data, "secret-token", 3600, now)).toThrow("expired");
  });
});

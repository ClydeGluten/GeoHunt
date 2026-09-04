import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createTelegramChatLink,
  createTelegramChatProof,
} from "./chat-link.js";

describe("Telegram chat links", () => {
  it("binds chat proofs to the requesting user and issue time", () => {
    const expected = createHmac("sha256", "shared-service-secret")
      .update("-100123\n42\n1788512400")
      .digest("hex");

    expect(
      createTelegramChatProof(
        "-100123",
        "42",
        1_788_512_400,
        "shared-service-secret",
      ),
    ).toBe(expected);
  });

  it("puts the complete signed grant in the create URL", () => {
    const href = createTelegramChatLink(
      "https://example.test/app",
      "-100123",
      "42",
      1_788_512_400,
      "shared-service-secret",
    );
    const link = new URL(href);

    expect(link.origin + link.pathname).toBe("https://example.test/app");
    expect(Object.fromEntries(link.searchParams)).toMatchObject({
      create: "1",
      chat: "-100123",
      chatUser: "42",
      chatIssued: "1788512400",
      chatProof: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });
});

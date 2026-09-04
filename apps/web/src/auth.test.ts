import { describe, expect, it } from "vitest";
import {
  hasAccountIdentity,
  readTelegramChatGrant,
  shouldOfferBrowserLogin,
} from "./auth";

describe("account identity", () => {
  it("treats browser sessions as authenticated accounts", () => {
    expect(
      hasAccountIdentity({
        kind: "WEB",
        account: { id: "account", displayName: "Browser Host" },
        participantId: null,
      }),
    ).toBe(true);
  });

  it("offers browser login to guests who try to host", () => {
    const guest = {
      kind: "GUEST" as const,
      account: null,
      participantId: "participant",
    };

    expect(shouldOfferBrowserLogin(guest, "home")).toBe(true);
    expect(shouldOfferBrowserLogin(guest, "create")).toBe(true);
    expect(shouldOfferBrowserLogin(guest, "game")).toBe(false);
  });

  it("reads only complete Telegram chat grants from the URL", () => {
    const complete = new URLSearchParams({
      chat: "-100123",
      chatUser: "42",
      chatIssued: "1788512400",
      chatProof: "a".repeat(64),
    });
    expect(readTelegramChatGrant(complete)).toEqual({
      telegramChatId: "-100123",
      telegramUserId: "42",
      telegramChatProofIssuedAt: 1_788_512_400,
      telegramChatProof: "a".repeat(64),
    });

    complete.delete("chatUser");
    expect(readTelegramChatGrant(complete)).toBeNull();
  });
});

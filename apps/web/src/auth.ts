import type { AuthMe } from "./types";

export interface TelegramChatGrant {
  telegramChatId: string;
  telegramUserId: string;
  telegramChatProofIssuedAt: number;
  telegramChatProof: string;
}

export function readTelegramChatGrant(
  search: URLSearchParams,
): TelegramChatGrant | null {
  const telegramChatId = search.get("chat");
  const telegramUserId = search.get("chatUser");
  const issued = search.get("chatIssued");
  const telegramChatProof = search.get("chatProof");
  const telegramChatProofIssuedAt = Number(issued);
  if (
    !telegramChatId ||
    !telegramUserId ||
    !issued ||
    !telegramChatProof ||
    !/^-?\d+$/.test(telegramChatId) ||
    !/^\d+$/.test(telegramUserId) ||
    !Number.isSafeInteger(telegramChatProofIssuedAt) ||
    telegramChatProofIssuedAt <= 0 ||
    !/^[a-f0-9]{64}$/i.test(telegramChatProof)
  ) {
    return null;
  }
  return {
    telegramChatId,
    telegramUserId,
    telegramChatProofIssuedAt,
    telegramChatProof,
  };
}

export function hasAccountIdentity(auth: AuthMe): boolean {
  return auth.account !== null;
}

export function shouldOfferBrowserLogin(
  auth: AuthMe,
  page: "home" | "create" | "game" | "replay",
): boolean {
  return !hasAccountIdentity(auth) && (page === "home" || page === "create");
}

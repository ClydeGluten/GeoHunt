import { createHmac } from "node:crypto";

export function createTelegramChatLink(
  webAppUrl: string,
  chatId: string,
  telegramUserId: string,
  issuedAt: number,
  serviceToken: string,
): string {
  const url = new URL(webAppUrl);
  url.searchParams.set("create", "1");
  url.searchParams.set("chat", chatId);
  url.searchParams.set("chatUser", telegramUserId);
  url.searchParams.set("chatIssued", String(issuedAt));
  url.searchParams.set(
    "chatProof",
    createTelegramChatProof(chatId, telegramUserId, issuedAt, serviceToken),
  );
  return url.toString();
}

export function createTelegramChatProof(
  chatId: string,
  telegramUserId: string,
  issuedAt: number,
  serviceToken: string,
): string {
  return createHmac("sha256", serviceToken)
    .update(`${chatId}\n${telegramUserId}\n${issuedAt}`)
    .digest("hex");
}

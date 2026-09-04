import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export interface TelegramUserData {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  photo_url?: string;
}

export function hashToken(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function newOpaqueToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function validateTelegramInitData(initData: string, botToken: string, maxAgeSeconds: number, now = new Date()): TelegramUserData {
  const parameters = new URLSearchParams(initData);
  const receivedHash = parameters.get("hash");
  if (!receivedHash || !/^[a-f0-9]{64}$/i.test(receivedHash)) throw new Error("Telegram hash missing or malformed");
  parameters.delete("hash");

  const dataCheckString = [...parameters.entries()]
    .sort(([first], [second]) => first.localeCompare(second))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const secretKey = createHmac("sha256", "WebAppData").update(botToken).digest();
  const calculated = createHmac("sha256", secretKey).update(dataCheckString).digest();
  const received = Buffer.from(receivedHash, "hex");
  if (received.length !== calculated.length || !timingSafeEqual(received, calculated)) throw new Error("Telegram signature invalid");

  const authDate = Number(parameters.get("auth_date"));
  if (!Number.isFinite(authDate)) throw new Error("Telegram auth_date missing");
  const ageSeconds = Math.floor(now.getTime() / 1000) - authDate;
  if (ageSeconds < -30 || ageSeconds > maxAgeSeconds) throw new Error("Telegram authentication expired");

  const rawUser = parameters.get("user");
  if (!rawUser) throw new Error("Telegram user missing");
  const user = JSON.parse(rawUser) as TelegramUserData;
  if (!Number.isSafeInteger(user.id) || !user.first_name) throw new Error("Telegram user malformed");
  return user;
}

export function parseCookieHeader(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const item of header.split(";")) {
    const separator = item.indexOf("=");
    if (separator < 0) continue;
    const key = item.slice(0, separator).trim();
    if (key === name) return decodeURIComponent(item.slice(separator + 1).trim());
  }
  return null;
}

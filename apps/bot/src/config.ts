import { z } from "zod";

const BotConfigSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  BOT_MODE: z.enum(["disabled", "polling", "webhook"]).default("polling"),
  BOT_TOKEN: z.string().min(20),
  BOT_WEBHOOK_SECRET: z.string().min(16).default("development-webhook-secret"),
  BOT_SERVICE_TOKEN: z.string().min(16).default("development-service-token"),
  API_INTERNAL_URL: z.url().default("http://localhost:3000/api"),
  PUBLIC_WEBAPP_URL: z.url().default("http://localhost:5173"),
  PUBLIC_BASE_URL: z.url().optional(),
  BOT_PORT: z.coerce.number().int().positive().default(3001),
  BOT_POLLING_START_DELAY_SECONDS: z.coerce
    .number()
    .int()
    .min(0)
    .max(120)
    .default(35),
});

export type BotConfig = z.infer<typeof BotConfigSchema>;

export function loadBotConfig(
  environment: NodeJS.ProcessEnv = process.env,
): BotConfig {
  const config = BotConfigSchema.parse(environment);
  if (
    config.NODE_ENV === "production" &&
    (config.BOT_WEBHOOK_SECRET === "development-webhook-secret" ||
      config.BOT_SERVICE_TOKEN === "development-service-token")
  )
    throw new Error(
      "BOT_WEBHOOK_SECRET and BOT_SERVICE_TOKEN must be set in production",
    );
  return config;
}

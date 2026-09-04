import { z } from "zod";

const ConfigSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default("0.0.0.0"),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  BOT_TOKEN: z.string().min(10).default("development-bot-token"),
  BOT_SERVICE_TOKEN: z.string().min(16).default("development-service-token"),
  SESSION_COOKIE_NAME: z.string().default("geohunter_session"),
  SESSION_DAYS: z.coerce.number().int().min(1).max(90).default(30),
  TELEGRAM_AUTH_MAX_AGE_SECONDS: z.coerce
    .number()
    .int()
    .min(60)
    .max(86_400)
    .default(3600),
  PUBLIC_WEBAPP_URL: z.string().url().default("http://localhost"),
  CORS_ORIGIN: z.string().default("http://localhost,http://localhost:5173"),
  DEV_AUTH_ENABLED: z
    .string()
    .default("false")
    .transform((value) => value === "true"),
  COOKIE_SECURE: z
    .string()
    .default("true")
    .transform((value) => value === "true"),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
});

export type ApiConfig = z.infer<typeof ConfigSchema>;

export function loadConfig(
  environment: NodeJS.ProcessEnv = process.env,
): ApiConfig {
  const config = ConfigSchema.parse(environment);
  if (
    config.NODE_ENV === "production" &&
    (config.BOT_TOKEN === "development-bot-token" ||
      config.BOT_SERVICE_TOKEN === "development-service-token")
  ) {
    throw new Error(
      "BOT_TOKEN and BOT_SERVICE_TOKEN must be set in production",
    );
  }
  return config;
}

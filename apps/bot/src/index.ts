import type { MatchAction, MatchState } from "@geohunter/contracts";
import Fastify from "fastify";
import { Bot, InlineKeyboard, type CommandContext, type Context } from "grammy";
import { createTelegramChatLink } from "./chat-link.js";
import { loadBotConfig } from "./config.js";
import { matchesForMode, type MatchMenuMode } from "./matches.js";

const config = loadBotConfig();
const bot = new Bot(config.BOT_TOKEN);

interface MatchListItem {
  id: string;
  name: string;
  state: MatchState;
  participantCount: number;
}

function webAppUrl(parameters: Record<string, string>) {
  const url = new URL(config.PUBLIC_WEBAPP_URL);
  Object.entries(parameters).forEach(([key, value]) =>
    url.searchParams.set(key, value),
  );
  return url.toString();
}

function launchButton(label: string, url: string, privateChat: boolean) {
  const keyboard = new InlineKeyboard();
  return privateChat ? keyboard.webApp(label, url) : keyboard.url(label, url);
}

function createButton(
  chatId?: number,
  telegramUserId?: number,
  privateChat = false,
) {
  const chat = chatId === undefined ? null : String(chatId);
  const user = telegramUserId === undefined ? null : String(telegramUserId);
  const issuedAt = Math.floor(Date.now() / 1000);
  const url =
    chat && user
      ? createTelegramChatLink(
          config.PUBLIC_WEBAPP_URL,
          chat,
          user,
          issuedAt,
          config.BOT_SERVICE_TOKEN,
        )
      : webAppUrl({ create: "1" });
  return launchButton("Create a hunt", url, privateChat);
}

async function internal<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${config.API_INTERNAL_URL}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      "x-bot-service-token": config.BOT_SERVICE_TOKEN,
      ...init?.headers,
    },
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as {
      message?: string;
    };
    throw new Error(body.message ?? `Game server returned ${response.status}`);
  }
  return response.json() as Promise<T>;
}

if (config.BOT_MODE !== "disabled")
  void bot.api
    .setMyCommands([
      { command: "start", description: "Open GeoHunter or accept an invite" },
      { command: "newgame", description: "Create a new hunt" },
      { command: "games", description: "List your hosted matches" },
      { command: "lobby", description: "Open your match lobby" },
      { command: "invite", description: "Create a fresh player invite" },
      { command: "results", description: "Open a finished match replay" },
    ])
    .catch(() => undefined);

if (config.BOT_MODE !== "disabled")
  void bot.api
    .setChatMenuButton({
      menu_button: {
        type: "web_app",
        text: "Open GeoHunter",
        web_app: { url: config.PUBLIC_WEBAPP_URL },
      },
    })
    .catch(() => undefined);

bot.command("start", async (context) => {
  const start = context.match?.trim();
  if (start) {
    await context.reply(
      "The trail is ready. Open the game, review location recording, and join the lobby.",
      {
        reply_markup: launchButton(
          "Join GeoHunter",
          webAppUrl({ invite: start }),
          context.chat.type === "private",
        ),
      },
    );
    return;
  }
  await context.reply(
    "GeoHunter turns a real neighbourhood into a live hide-and-seek arena.",
    {
      reply_markup: createButton(
        context.chat.id,
        context.from?.id,
        context.chat.type === "private",
      ),
    },
  );
});

bot.command("newgame", async (context) =>
  context.reply("Draw the playzone and set the rules in the Mini App.", {
    reply_markup: createButton(
      context.chat.id,
      context.from?.id,
      context.chat.type === "private",
    ),
  }),
);

async function showMatches(
  context: CommandContext<Context>,
  mode: MatchMenuMode = "manage",
) {
  const userId = context.from?.id;
  if (!userId) return context.reply("Telegram user identity is required.");
  try {
    const matches = await internal<MatchListItem[]>(
      `/internal/telegram/${userId}/matches`,
    );
    if (!matches.length)
      return context.reply("No hosted matches yet.", {
        reply_markup: createButton(
          context.chat.id,
          context.from?.id,
          context.chat.type === "private",
        ),
      });
    const visibleMatches = matchesForMode(matches, mode);
    if (!visibleMatches.length)
      return context.reply("No finished matches yet.");
    const keyboard = new InlineKeyboard();
    visibleMatches.forEach((match) => {
      const marker =
        match.state === "ACTIVE" ? "🟢" : match.state === "PAUSED" ? "⏸" : "⌖";
      if (mode === "invite")
        keyboard.text(`${marker} ${match.name}`, `invite:${match.id}`).row();
      else {
        const url = webAppUrl(
          mode === "results" ? { replay: match.id } : { match: match.id },
        );
        if (context.chat.type === "private")
          keyboard
            .webApp(`${marker} ${match.name} · ${match.participantCount}`, url)
            .row();
        else
          keyboard
            .url(`${marker} ${match.name} · ${match.participantCount}`, url)
            .row();
        if (mode === "manage") {
          if (match.state === "DRAFT")
            keyboard.text("Open lobby", `act:OPEN_LOBBY:${match.id}`);
          if (match.state === "LOBBY")
            keyboard.text("Start", `act:START:${match.id}`);
          if (["HIDING", "ACTIVE"].includes(match.state))
            keyboard
              .text("Pause", `act:PAUSE:${match.id}`)
              .text("End", `act:END:${match.id}`);
          if (match.state === "PAUSED")
            keyboard
              .text("Resume", `act:RESUME:${match.id}`)
              .text("End", `act:END:${match.id}`);
          if (!["FINISHED", "CANCELED"].includes(match.state)) keyboard.row();
        }
      }
    });
    return context.reply(
      mode === "invite"
        ? "Choose a match to rotate its invite:"
        : "Choose a match:",
      { reply_markup: keyboard },
    );
  } catch (error) {
    return context.reply(
      error instanceof Error ? error.message : "Could not load matches",
    );
  }
}

bot.command("games", (context) => showMatches(context));
bot.command("lobby", (context) => showMatches(context, "lobby"));
bot.command("invite", (context) => showMatches(context, "invite"));
bot.command("results", (context) => showMatches(context, "results"));

bot.callbackQuery(/^invite:([0-9a-f-]{36})$/, async (context) => {
  if (!context.from) return;
  try {
    const result = await internal<{ inviteUrl: string }>(
      `/internal/telegram/${context.from.id}/matches/${context.match[1]}/invite`,
      { method: "POST" },
    );
    await context.answerCallbackQuery("Invite created");
    await context.reply(
      "Send this button to your players. Creating a new invite disables the previous one.",
      {
        reply_markup: new InlineKeyboard().url(
          "Share invite",
          `https://t.me/share/url?url=${encodeURIComponent(result.inviteUrl)}`,
        ),
      },
    );
  } catch (error) {
    await context.answerCallbackQuery({
      text: error instanceof Error ? error.message : "Invite failed",
      show_alert: true,
    });
  }
});

bot.callbackQuery(/^act:([A-Z_]+):([0-9a-f-]{36})$/, async (context) => {
  if (!context.from) return;
  const action = context.match[1] as MatchAction;
  try {
    const result = await internal<{ state: MatchState }>(
      `/internal/telegram/${context.from.id}/matches/${context.match[2]}/actions`,
      { method: "POST", body: JSON.stringify({ action }) },
    );
    await context.answerCallbackQuery(
      `Match is now ${result.state.toLowerCase()}`,
    );
  } catch (error) {
    await context.answerCallbackQuery({
      text: error instanceof Error ? error.message : "Action failed",
      show_alert: true,
    });
  }
});

bot.catch(({ error }) => console.error("Bot update failed", error));

const server = Fastify({ logger: true });
server.get("/health", async () => ({ ok: true, service: "geohunter-bot" }));
server.post("/bot/webhook", async (request, reply) => {
  if (
    request.headers["x-telegram-bot-api-secret-token"] !==
    config.BOT_WEBHOOK_SECRET
  )
    return reply.code(403).send({ ok: false });
  await bot.handleUpdate(
    request.body as Parameters<typeof bot.handleUpdate>[0],
  );
  return { ok: true };
});

// grammY's webhook handler requires bot metadata to be initialized before the
// first update arrives. Do this before opening the HTTP port so Telegram can
// never race server startup.
if (config.BOT_MODE === "webhook") await bot.init();
await server.listen({ host: "0.0.0.0", port: config.BOT_PORT });
let shuttingDown = false;
const delay = (milliseconds: number) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

if (config.BOT_MODE === "webhook") {
  if (!config.PUBLIC_BASE_URL)
    throw new Error("PUBLIC_BASE_URL is required for production webhook mode");
  await bot.api.setWebhook(`${config.PUBLIC_BASE_URL}/bot/webhook`, {
    secret_token: config.BOT_WEBHOOK_SECRET,
    allowed_updates: ["message", "callback_query"],
  });
} else if (config.BOT_MODE === "polling") {
  await bot.api.deleteWebhook({ drop_pending_updates: false });
  void (async () => {
    if (config.BOT_POLLING_START_DELAY_SECONDS > 0) {
      await delay(config.BOT_POLLING_START_DELAY_SECONDS * 1000);
    }
    while (!shuttingDown) {
      try {
        await bot.start({ allowed_updates: ["message", "callback_query"] });
      } catch (error) {
        if (shuttingDown) return;
        console.error(
          "Telegram polling interrupted; retrying in 5 seconds",
          error,
        );
        await delay(5000);
      }
    }
  })();
}

const shutdown = async () => {
  shuttingDown = true;
  if (config.BOT_MODE === "polling" && bot.isRunning()) await bot.stop();
  await server.close();
};
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());

import { Hono } from "hono";
import { type TelegramOptions, telegramRoutes } from "./adapters/telegram";
import { createTelegramApi } from "./adapters/telegram-api";
import { webRoutes } from "./adapters/web";
import { assistantConfigFromEnv } from "./assistant/config";
import type { AssistantDeps } from "./assistant/types";
import { ValidationError } from "./lib/errors";
import { createGeminiClient } from "./llm/gemini";

/** The real assistant dependencies: Gemini and the limits from configuration. */
function productionDeps(env: Env): AssistantDeps {
  return {
    db: env.DB,
    llm: createGeminiClient({ apiKey: env.GEMINI_API_KEY, model: env.GEMINI_MODEL }),
    config: assistantConfigFromEnv(env),
  };
}

/** The real Telegram wiring: the bot token and webhook secret from the Worker's secrets. */
const productionTelegram: TelegramOptions = {
  makeApi: (env) => createTelegramApi({ token: env.TELEGRAM_BOT_TOKEN }),
  secret: (env) => env.TELEGRAM_WEBHOOK_SECRET,
};

/**
 * Builds the Worker's HTTP app. `makeDeps` and `telegram` exist so tests can
 * run the real routes against a scripted model and a recorded Telegram instead
 * of the real services.
 */
export function createApp(
  options: { makeDeps?: (env: Env) => AssistantDeps; telegram?: TelegramOptions } = {},
) {
  const app = new Hono<{ Bindings: Env }>();

  /** Liveness check. Also proves the D1 binding is reachable. */
  app.get("/api/health", async (c) => {
    try {
      await c.env.DB.prepare("SELECT 1").first();
      return c.json({ status: "ok", database: "ok" });
    } catch {
      return c.json({ status: "degraded", database: "unreachable" }, 503);
    }
  });

  // Two channels, one assistant: both adapters are given the same dependencies.
  const makeDeps = options.makeDeps ?? productionDeps;
  app.route("/api", webRoutes(makeDeps));
  app.route("/webhooks/telegram", telegramRoutes(makeDeps, options.telegram ?? productionTelegram));

  app.notFound((c) => c.json({ error: { code: "not_found", message: "Route not found" } }, 404));

  app.onError((err, c) => {
    if (err instanceof ValidationError) {
      return c.json({ error: { code: "invalid_request", message: err.issues.join(" ") } }, 400);
    }
    // The error itself may carry request data; only its type is logged.
    console.error(`unhandled_error name=${err instanceof Error ? err.name : "unknown"}`);
    return c.json({ error: { code: "internal_error", message: "Something went wrong" } }, 500);
  });

  return app;
}

export default createApp();

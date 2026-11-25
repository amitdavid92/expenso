/**
 * Registers, inspects or removes the Telegram webhook for the bot.
 *
 *   npm run telegram -- info                         who the bot is, and where its webhook points
 *   npm run telegram -- set https://your-worker-url  point the bot at <url>/webhooks/telegram
 *   npm run telegram -- delete                       remove the webhook
 *   npm run telegram -- secret                       print a new random webhook secret to copy
 *
 * The bot token and the webhook secret are read from worker/.dev.vars the same
 * way `wrangler dev` reads them. Neither is ever printed. Telegram needs a
 * public HTTPS address, so `set` only makes sense for a deployed Worker or a tunnel.
 */
import { getPlatformProxy } from "wrangler";
import { TelegramError, createTelegramApi } from "../src/adapters/telegram-api";

const [command, argument] = process.argv.slice(2);
const WEBHOOK_PATH = "/webhooks/telegram";

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

if (command === "secret") {
  // A fresh value, generated here and stored nowhere. Telegram allows A-Z, a-z, 0-9, _ and -.
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const value = Buffer.from(bytes).toString("base64url");
  console.log("Add this line to worker/.dev.vars, and set the same value on the deployed Worker");
  console.log("with `npx wrangler secret put TELEGRAM_WEBHOOK_SECRET`:\n");
  console.log(`TELEGRAM_WEBHOOK_SECRET=${value}`);
  process.exit(0);
}

if (!["info", "set", "delete"].includes(command ?? "")) {
  fail("Usage: npm run telegram -- info | set <https-url> | delete | secret");
}

const { env, dispose } = await getPlatformProxy<Env>();

try {
  if (!env.TELEGRAM_BOT_TOKEN) fail("TELEGRAM_BOT_TOKEN is not set in worker/.dev.vars.");
  const api = createTelegramApi({ token: env.TELEGRAM_BOT_TOKEN });

  if (command === "info") {
    const me = await api.call<{ username?: string; id: number }>("getMe", {});
    const hook = await api.call<{
      url?: string;
      pending_update_count?: number;
      last_error_date?: number;
      last_error_message?: string;
      allowed_updates?: string[];
    }>("getWebhookInfo", {});
    console.log(`Bot:      @${me.username ?? "(no username)"}`);
    console.log(`Webhook:  ${hook.url || "(none registered)"}`);
    console.log(`Pending:  ${hook.pending_update_count ?? 0} update(s) waiting`);
    if (hook.allowed_updates?.length) console.log(`Updates:  ${hook.allowed_updates.join(", ")}`);
    if (hook.last_error_message) {
      const when = hook.last_error_date ? new Date(hook.last_error_date * 1000).toISOString() : "unknown time";
      console.log(`Last delivery error (${when}): ${hook.last_error_message}`);
    }
    console.log(`Secret:   ${env.TELEGRAM_WEBHOOK_SECRET ? "set locally" : "NOT set locally (run: npm run telegram -- secret)"}`);
  }

  if (command === "set") {
    let base: URL;
    try {
      base = new URL(argument ?? "");
    } catch {
      fail("Give the public address of the Worker, e.g. npm run telegram -- set https://expenso.example.workers.dev");
    }
    if (base.protocol !== "https:") fail("Telegram only delivers to HTTPS addresses.");
    const secret = env.TELEGRAM_WEBHOOK_SECRET;
    if (!secret) fail("TELEGRAM_WEBHOOK_SECRET is not set. Run: npm run telegram -- secret");
    if (!/^[A-Za-z0-9_-]{16,256}$/.test(secret)) {
      fail("TELEGRAM_WEBHOOK_SECRET must be 16-256 characters of A-Z, a-z, 0-9, _ or -.");
    }

    const url = new URL(WEBHOOK_PATH, base).toString();
    await api.call("setWebhook", {
      url,
      secret_token: secret,
      // Only what the adapter handles; everything else is not sent at all.
      allowed_updates: ["message", "callback_query"],
      // Anything queued for an old address is dropped rather than replayed.
      drop_pending_updates: true,
    });
    await api.call("setMyCommands", {
      commands: [
        { command: "start", description: "What Expenso does" },
        { command: "confirm", description: "Submit the current draft" },
        { command: "cancel", description: "Discard the current draft" },
        { command: "help", description: "How it works" },
      ],
    });
    console.log(`Webhook registered: ${url}`);
    console.log("The Worker at that address must have the same TELEGRAM_WEBHOOK_SECRET, or it will answer 401.");
  }

  if (command === "delete") {
    await api.call("deleteWebhook", { drop_pending_updates: true });
    console.log("Webhook removed. The bot will not receive messages until one is registered again.");
  }
} catch (error) {
  // TelegramError never contains the token or a URL.
  if (error instanceof TelegramError) {
    console.error(
      error.status === 401 || error.status === 404
        ? "Telegram rejected the bot token. Check TELEGRAM_BOT_TOKEN."
        : error.message,
    );
  } else {
    console.error(error instanceof Error ? error.name : "Unexpected error");
  }
  process.exitCode = 1;
} finally {
  await dispose();
}

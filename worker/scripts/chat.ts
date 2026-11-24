/**
 * Talk to the shared assistant from a terminal, with the real Gemini model and
 * the local D1 database. No web or Telegram adapter is involved: this calls
 * `handleMessage` directly, exactly as those adapters will.
 *
 *   npm run chat                     interactive
 *   npm run chat -- --user dana      a named user (each name has its own history)
 *   npm run chat -- --new            a brand-new user
 *   npm run chat < messages.txt      scripted: one message per line
 *
 * Needs GEMINI_API_KEY in worker/.dev.vars and `npm run db:migrate:local` once.
 */
import { createInterface } from "node:readline";
import { getPlatformProxy } from "wrangler";
import { handleMessage } from "../src/assistant/assistant";
import { assistantConfigFromEnv } from "../src/assistant/config";
import { createGeminiClient } from "../src/llm/gemini";
import { findOrCreateUser } from "../src/services/users";

const args = process.argv.slice(2);
const named = args.includes("--user") ? args[args.indexOf("--user") + 1] : undefined;
const userName = args.includes("--new") ? crypto.randomUUID().slice(0, 8) : (named ?? "demo");

// Reads wrangler.jsonc and .dev.vars the same way `wrangler dev` does.
const { env, dispose } = await getPlatformProxy<Env>();

try {
  if (!env.GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY is not set. Copy .env.example to worker/.dev.vars and fill it in.");
  }
  const tables = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'users'",
  ).first();
  if (!tables) throw new Error("The local database is empty. Run: npm run db:migrate:local");

  const deps = {
    db: env.DB,
    llm: createGeminiClient({ apiKey: env.GEMINI_API_KEY, model: env.GEMINI_MODEL }),
    config: assistantConfigFromEnv(env),
  };
  const user = await findOrCreateUser(env.DB, { channel: "web", externalId: `cli:${userName}` });

  const interactive = process.stdin.isTTY === true;
  console.log(`Expenso local chat · model ${env.GEMINI_MODEL} · user "${userName}"`);
  if (interactive) console.log('Type a message. "confirm" / "cancel" act on the draft. Ctrl+D to quit.\n');

  const lines = createInterface({ input: process.stdin, prompt: "you> " });
  if (interactive) lines.prompt();
  for await (const line of lines) {
    const text = line.trim();
    if (text !== "") {
      if (!interactive) console.log(`\nyou> ${text}`);
      const started = Date.now();
      const result = await handleMessage(deps, { userId: user.id, text });
      console.log(`expenso> ${result.reply.replaceAll("\n", "\n         ")}`);
      const notes = [`${Date.now() - started} ms`];
      if (result.error) notes.push(`error: ${result.error}`);
      if (result.pendingExpense) notes.push(`draft #${result.pendingExpense.id} pending`);
      console.log(`         [${notes.join(" · ")}]`);
    }
    if (interactive) lines.prompt();
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await dispose();
}

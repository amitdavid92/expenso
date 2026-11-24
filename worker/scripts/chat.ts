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
 * Inside the chat, a line of the form
 *
 *   /receipt samples/receipt-cafe-aurora.png  [optional caption]
 *
 * sends that image through receipt analysis (`handleReceipt`), the same call the
 * web and Telegram adapters will make for a photo.
 *
 * Needs GEMINI_API_KEY in worker/.dev.vars and `npm run db:migrate:local` once.
 */
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { getPlatformProxy } from "wrangler";
import { handleMessage } from "../src/assistant/assistant";
import { assistantConfigFromEnv } from "../src/assistant/config";
import { handleReceipt } from "../src/assistant/receipts";
import type { AssistantReply } from "../src/assistant/types";
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
  if (interactive) {
    console.log('Type a message. "confirm" / "cancel" act on the draft. Ctrl+D to quit.');
    console.log("Send a receipt with: /receipt <path to .png or .jpg> [caption]\n");
  }

  /** "/receipt <path> [caption]": reads the file and runs receipt analysis on it. */
  async function sendReceipt(line: string): Promise<AssistantReply | string> {
    const [, path, ...captionWords] = line.split(/\s+/);
    if (!path) return "Usage: /receipt <path to .png or .jpg> [caption]";
    let image: Uint8Array;
    try {
      image = new Uint8Array(await readFile(path));
    } catch {
      return `Could not read the file "${path}" (paths are relative to the worker folder).`;
    }
    return handleReceipt(deps, { userId: user.id, image, caption: captionWords.join(" ") });
  }

  const lines = createInterface({ input: process.stdin, prompt: "you> " });
  if (interactive) lines.prompt();
  for await (const line of lines) {
    const text = line.trim();
    if (text !== "") {
      if (!interactive) console.log(`\nyou> ${text}`);
      const started = Date.now();
      const result = text.startsWith("/receipt")
        ? await sendReceipt(text)
        : await handleMessage(deps, { userId: user.id, text });
      if (typeof result === "string") {
        console.log(result);
        if (interactive) lines.prompt();
        continue;
      }
      console.log(`expenso> ${result.reply.replaceAll("\n", "\n         ")}`);
      const notes = [`${Date.now() - started} ms`];
      if (result.error) notes.push(`error: ${result.error}`);
      if (result.receipt) {
        notes.push(`receipt: ${result.receipt.status}`);
        if (result.receipt.missing.length > 0) notes.push(`missing: ${result.receipt.missing.join(", ")}`);
      }
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

import type { TelegramApi } from "./telegram-api";

/**
 * What the two channels need to know about each other. Kept apart from both
 * adapters so neither imports the other, and so tests can replace it.
 */
export interface ChannelOptions {
  /** Server key used to hash short handoff codes. Without one, codes cannot be issued or checked. */
  linkKey: (env: Env) => string | undefined;
  /** The configured, validated public address of the web app, or null if there is none. */
  webUrl: (env: Env) => string | null;
  /** The Telegram API, for notices about things done on the web. Null if Telegram is not configured. */
  telegramApi: (env: Env) => TelegramApi | null;
}

/**
 * Runs `work` after the response if the platform allows it, otherwise now.
 * Whatever it does, it cannot fail the request it belongs to.
 */
export async function afterResponse(
  context: { executionCtx: { waitUntil(promise: Promise<unknown>): void } },
  work: Promise<unknown>,
): Promise<void> {
  const safe = work.catch(() => {});
  let background: { waitUntil(promise: Promise<unknown>): void } | undefined;
  try {
    background = context.executionCtx;
  } catch {
    // No execution context (tests): run it before answering instead.
  }
  if (background) background.waitUntil(safe);
  else await safe;
}

import { Hono } from "hono";
import { cancelDraftById, confirmDraftById, handleMessage } from "../assistant/assistant";
import { handleReceipt, resolvePendingCurrency } from "../assistant/receipts";
import type { AssistantDeps, AssistantReply } from "../assistant/types";
import { MAX_IMAGE_BYTES } from "../lib/images";
import { latestMessageId, listMessagesAfter } from "../services/conversations";
import { handoffLink, issueHandoff } from "../services/handoff";
import { revokeWebAccess } from "../services/sessions";
import { findOrCreateUser } from "../services/users";
import type { ChannelOptions } from "./channels";
import { toMessageDtos } from "./present";
import { type TelegramApi, TelegramError } from "./telegram-api";
import {
  DOWNLOAD_FAILED,
  HELP,
  SOMETHING_WRONG,
  TOOK_TOO_LONG,
  TOO_LARGE,
  type TelegramMessage,
  UNSUPPORTED,
  WELCOME,
  continueOnWebRow,
  esc,
  hasDraftButtons,
  parseCallback,
  renderMessage,
  webAccessMessage,
} from "./telegram-render";

/**
 * The Telegram channel. Like the web adapter it knows its own transport
 * (webhook updates, chat ids, inline buttons, file downloads) and nothing
 * about expense rules: it resolves the user, calls the same assistant
 * functions the web app calls, and renders the same typed messages.
 *
 * A webhook must be answered quickly or Telegram redelivers it, so the route
 * replies 200 at once and does the work afterwards, inside the Worker's
 * background window.
 */

/**
 * Cloudflare allows about 30 seconds of work after the response. The whole
 * update (file download, model, replies) gets less than that, so there is
 * always time left to tell the user it took too long.
 */
const UPDATE_BUDGET_MS = 26_000;
/** Kept back from the assistant's deadline for sending the reply. */
const REPLY_RESERVE_MS = 2_500;
const TYPING_REFRESH_MS = 4_000;

export interface TelegramOptions {
  makeApi: (env: Env) => TelegramApi;
  /** The secret Telegram echoes back on every call. No secret, no webhook. */
  secret: (env: Env) => string | undefined;
}

// Only the fields this adapter reads. Everything arrives as untrusted JSON.
interface TgChat {
  id: number;
  type: string;
}
interface TgUser {
  id: number;
  first_name?: string;
}
interface TgFile {
  file_id: string;
  file_size?: number;
  mime_type?: string;
}
interface TgMessage {
  message_id: number;
  chat: TgChat;
  from?: TgUser;
  text?: string;
  caption?: string;
  photo?: TgFile[];
  document?: TgFile;
  [other: string]: unknown;
}
interface TgCallback {
  id: string;
  from: TgUser;
  data?: string;
  message?: { message_id: number; chat: TgChat };
}
interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  callback_query?: TgCallback;
}

const isId = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value);

/** Compares two strings without stopping at the first difference. */
function sameSecret(given: string | undefined, expected: string): boolean {
  if (given === undefined || given.length !== expected.length) return false;
  let difference = 0;
  for (let i = 0; i < expected.length; i++) difference |= given.charCodeAt(i) ^ expected.charCodeAt(i);
  return difference === 0;
}

export function telegramRoutes(
  makeDeps: (env: Env) => AssistantDeps,
  options: TelegramOptions,
  channels: ChannelOptions,
) {
  const routes = new Hono<{ Bindings: Env }>();

  routes.post("/", async (c) => {
    const secret = options.secret(c.env);
    if (!secret) {
      console.error("telegram_webhook_secret_missing");
      return c.json({ error: { code: "not_configured", message: "Webhook is not configured." } }, 503);
    }
    if (!sameSecret(c.req.header("x-telegram-bot-api-secret-token"), secret)) {
      return c.json({ error: { code: "unauthorized", message: "Unauthorized." } }, 401);
    }

    // From here on the answer is always 200: an error status makes Telegram
    // send the same update again, which cannot help.
    const update = (await c.req.json().catch(() => null)) as TgUpdate | null;
    if (!update || !isId(update.update_id)) return c.json({ ok: true });

    // Everything said here is marked as coming from Telegram, so the shared conversation can show it.
    const deps: AssistantDeps = { ...makeDeps(c.env), channel: "telegram" };
    // Telegram may deliver an update more than once. The first insert wins.
    const fresh = await deps.db
      .prepare("INSERT INTO telegram_updates (update_id) VALUES (?) ON CONFLICT DO NOTHING RETURNING update_id")
      .bind(update.update_id)
      .first();
    if (!fresh) return c.json({ ok: true });

    const link: LinkConfig = { key: channels.linkKey(c.env), webUrl: channels.webUrl(c.env) };
    const work = handleUpdate(deps, options.makeApi(c.env), update, link);
    let background: { waitUntil(promise: Promise<unknown>): void } | undefined;
    try {
      background = c.executionCtx;
    } catch {
      // No execution context (tests): the work is awaited below instead.
    }
    if (background) background.waitUntil(work);
    else await work;
    return c.json({ ok: true });
  });

  return routes;
}

/** What the bot needs to offer the web: a key for codes and the configured public address. */
interface LinkConfig {
  key: string | undefined;
  webUrl: string | null;
}

/** Handles one update. Never throws: whatever happens, the user gets an answer if one can be sent. */
async function handleUpdate(deps: AssistantDeps, api: TelegramApi, update: TgUpdate, link: LinkConfig): Promise<void> {
  const chat = update.message?.chat ?? update.callback_query?.message?.chat;
  const startedAt = Date.now();

  const send = async (chatId: number, message: TelegramMessage) => {
    await api.call("sendMessage", {
      chat_id: chatId,
      text: message.text,
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      ...(message.buttons ? { reply_markup: { inline_keyboard: message.buttons } } : {}),
    });
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  const outOfTime = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), UPDATE_BUDGET_MS);
  });

  try {
    const work = update.message
      ? onMessage(deps, api, send, update.message, startedAt, link)
      : update.callback_query
        ? onCallback(deps, api, send, update.callback_query, link)
        : Promise.resolve();
    const result = await Promise.race([work, outOfTime]);
    if (result === "timeout" && chat && isId(chat.id) && chat.type === "private") {
      await send(chat.id, { text: TOOK_TOO_LONG });
    }
  } catch (error) {
    // Only the kind of failure is logged: never message text, file URLs or the token.
    console.error(
      error instanceof TelegramError
        ? `telegram_update_failed method=${error.method} kind=${error.kind} status=${error.status ?? "none"}`
        : `telegram_update_failed error=${error instanceof Error ? error.name : "unknown"}`,
    );
    if (chat && isId(chat.id) && chat.type === "private") {
      await send(chat.id, { text: SOMETHING_WRONG }).catch(() => {});
    }
  } finally {
    clearTimeout(timer);
  }
}

type Send = (chatId: number, message: TelegramMessage) => Promise<void>;

/** Shows "typing…" until stopped. Telegram clears it after about five seconds, so it is refreshed. */
function showTyping(api: TelegramApi, chatId: number): () => void {
  let stop: () => void = () => {};
  const stopped = new Promise<"stopped">((resolve) => {
    stop = () => resolve("stopped");
  });
  void (async () => {
    for (;;) {
      await api.call("sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => {});
      let timer: ReturnType<typeof setTimeout> | undefined;
      const tick = new Promise<"tick">((resolve) => {
        timer = setTimeout(() => resolve("tick"), TYPING_REFRESH_MS);
      });
      const next = await Promise.race([stopped, tick]);
      clearTimeout(timer);
      if (next === "stopped") return;
    }
  })();
  return stop;
}

/**
 * Runs one assistant call and sends what it added to the conversation, exactly
 * the way the web adapter answers a turn: by reading back the stored messages.
 */
async function turn(
  deps: AssistantDeps,
  send: Send,
  chatId: number,
  userId: number,
  run: (deps: AssistantDeps) => Promise<AssistantReply>,
  link: LinkConfig,
): Promise<void> {
  const before = await latestMessageId(deps.db, userId);
  const reply = await run(deps);
  const added = await listMessagesAfter(deps.db, userId, before);
  const messages = (await toMessageDtos(deps.db, userId, added)).filter((m) => m.role === "assistant");

  // Refused before anything was stored (e.g. a file that is not an image).
  if (messages.length === 0) {
    await send(chatId, { text: esc(reply.reply) });
    return;
  }
  for (const message of messages) {
    const rendered = renderMessage(message);
    // A draft to review is the moment to offer the bigger screen: one tap, one-time link.
    if (hasDraftButtons(rendered) && link.key && link.webUrl) {
      const ticket = await issueHandoff(deps.db, userId, link.key, (deps.now ?? (() => new Date()))());
      rendered.buttons = [...(rendered.buttons ?? []), continueOnWebRow(handoffLink(link.webUrl, ticket.token))];
    }
    await send(chatId, rendered);
  }
}

async function userIdFor(deps: AssistantDeps, from: TgUser): Promise<number> {
  const user = await findOrCreateUser(deps.db, {
    channel: "telegram",
    externalId: String(from.id),
    displayName: typeof from.first_name === "string" ? from.first_name : null,
  });
  return user.id;
}

/** Leaves the assistant only as much time as this update still has. */
function withinBudget(deps: AssistantDeps, startedAt: number): AssistantDeps {
  const left = Math.max(1_000, UPDATE_BUDGET_MS - (Date.now() - startedAt) - REPLY_RESERVE_MS);
  return {
    ...deps,
    config: {
      ...deps.config,
      deadlineMs: Math.min(deps.config.deadlineMs, left),
      receiptRequestTimeoutMs: Math.min(deps.config.receiptRequestTimeoutMs, left),
    },
  };
}

async function onMessage(
  deps: AssistantDeps,
  api: TelegramApi,
  send: Send,
  message: TgMessage,
  startedAt: number,
  link: LinkConfig,
): Promise<void> {
  const { chat, from } = message;
  // Private chats only: in a group there is no single person whose expenses these are.
  if (!chat || chat.type !== "private" || !isId(chat.id) || !from || !isId(from.id)) return;
  const chatId = chat.id;

  const text = typeof message.text === "string" ? message.text.trim() : "";
  let command: string | null = null;
  if (text.startsWith("/")) {
    // "/confirm@GetExpensoBot now" → "confirm"
    command = text.split(/\s+/)[0]!.slice(1).replace(/@\w+$/, "").toLowerCase();
  }

  if (command === "start") {
    await userIdFor(deps, from);
    return send(chatId, { text: WELCOME });
  }
  if (command === "web") {
    const userId = await userIdFor(deps, from);
    if (!link.key) return send(chatId, { text: "Continuing on the web is not set up on this server yet." });
    const ticket = await issueHandoff(deps.db, userId, link.key, (deps.now ?? (() => new Date()))());
    return send(
      chatId,
      webAccessMessage({ link: link.webUrl ? handoffLink(link.webUrl, ticket.token) : null, code: ticket.code, webUrl: link.webUrl }),
    );
  }
  if (command === "signout") {
    const userId = await userIdFor(deps, from);
    const browsers = await revokeWebAccess(deps.db, userId);
    return send(chatId, {
      text:
        browsers > 0
          ? `Signed out of ${browsers} ${browsers === 1 ? "browser" : "browsers"}. Any links or codes you had no longer work.`
          : "No browser was signed in. Any links or codes you had no longer work.",
    });
  }
  if (command !== null && command !== "confirm" && command !== "cancel") {
    return send(chatId, { text: command === "help" ? HELP : `I don't know that command.\n\n${HELP}` });
  }

  const userId = await userIdFor(deps, from);

  // A receipt: a compressed photo (Telegram offers several sizes) or an image sent as a file.
  const image = pickImage(message);
  if (image === "unsupported") return send(chatId, { text: UNSUPPORTED });
  if (image === "too_large") return send(chatId, { text: TOO_LARGE });

  const stopTyping = showTyping(api, chatId);
  try {
    if (image) {
      let bytes: Uint8Array;
      try {
        const file = await api.call<{ file_path?: string }>("getFile", { file_id: image.file_id });
        if (!file.file_path) throw new TelegramError("rejected", "getFile");
        bytes = await api.download(file.file_path, MAX_IMAGE_BYTES);
      } catch (error) {
        if (!(error instanceof TelegramError)) throw error;
        console.warn(`telegram_download_failed method=${error.method} kind=${error.kind}`);
        return await send(chatId, { text: error.kind === "too_large" ? TOO_LARGE : DOWNLOAD_FAILED });
      }
      const caption = typeof message.caption === "string" ? message.caption : undefined;
      // The bytes decide the format; what Telegram called the file does not.
      return await turn(
        withinBudget(deps, startedAt),
        send,
        chatId,
        userId,
        (d) => handleReceipt(d, { userId, image: bytes, caption }),
        link,
      );
    }

    if (text === "") return await send(chatId, { text: UNSUPPORTED });

    // "/confirm" and "/cancel" are the same exact commands the assistant already handles without the model.
    const input = command ?? text;
    return await turn(
      withinBudget(deps, startedAt),
      send,
      chatId,
      userId,
      (d) => handleMessage(d, { userId, text: input }),
      link,
    );
  } finally {
    stopTyping();
  }
}

/** The image to read from a message, if it carries one we accept. */
function pickImage(message: TgMessage): TgFile | "unsupported" | "too_large" | null {
  if (Array.isArray(message.photo) && message.photo.length > 0) {
    const sizes = message.photo.filter((p) => p && typeof p.file_id === "string");
    // Largest first; take the biggest one that is within the limit.
    sizes.sort((a, b) => (b.file_size ?? 0) - (a.file_size ?? 0));
    return sizes.find((p) => (p.file_size ?? 0) <= MAX_IMAGE_BYTES) ?? "too_large";
  }
  const document = message.document;
  if (document && typeof document.file_id === "string") {
    if (document.mime_type !== "image/jpeg" && document.mime_type !== "image/png") return "unsupported";
    if ((document.file_size ?? 0) > MAX_IMAGE_BYTES) return "too_large";
    return document;
  }
  const other = ["voice", "audio", "video", "video_note", "sticker", "animation", "location", "contact", "poll"];
  return other.some((kind) => message[kind] !== undefined) ? "unsupported" : null;
}

async function onCallback(
  deps: AssistantDeps,
  api: TelegramApi,
  send: Send,
  callback: TgCallback,
  link: LinkConfig,
): Promise<void> {
  // Always acknowledged first, so the button stops showing its spinner.
  await api.call("answerCallbackQuery", { callback_query_id: callback.id }).catch(() => {});

  const chat = callback.message?.chat;
  if (!chat || chat.type !== "private" || !isId(chat.id) || !callback.from || !isId(callback.from.id)) return;
  const action = parseCallback(callback.data);
  if (!action) return;

  const chatId = chat.id;
  // The press is from whoever Telegram says pressed it. The services then
  // check that the draft belongs to that user, so a forwarded or guessed
  // button cannot act on someone else's expense.
  const userId = await userIdFor(deps, callback.from);

  // The buttons have done their job (or are out of date): take them off the message.
  if (callback.message && isId(callback.message.message_id)) {
    await api
      .call("editMessageReplyMarkup", {
        chat_id: chatId,
        message_id: callback.message.message_id,
        reply_markup: { inline_keyboard: [] },
      })
      .catch(() => {});
  }

  const run = (d: AssistantDeps): Promise<AssistantReply> => {
    switch (action.kind) {
      case "confirm":
        return confirmDraftById(d, { userId, expenseId: action.expenseId });
      case "cancel":
        return cancelDraftById(d, { userId, expenseId: action.expenseId });
      case "currency":
        return resolvePendingCurrency(d, { userId, currency: action.currency });
    }
  };
  await turn(deps, send, chatId, userId, run, link);
}

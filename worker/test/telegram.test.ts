import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import type { Bootstrap } from "../../shared/contract";
import { type TelegramApi, TelegramError, createTelegramApi } from "../src/adapters/telegram-api";
import { createApp } from "../src/index";
import { LlmError } from "../src/llm/types";
import { getActiveDraft } from "../src/services/expenses";
import { findUser } from "../src/services/users";
import { FakeLlm, call, say } from "./fake-llm";

const NOW = new Date("2026-11-24T10:00:00Z");
const SECRET = "test-webhook-secret";
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

let llm = new FakeLlm();

/** A stand-in for the Telegram Bot API that records every call. */
class FakeTelegram implements TelegramApi {
  calls: { method: string; payload: Record<string, any> }[] = [];
  downloads: string[] = [];
  /** Methods that should fail, for failure tests. */
  failing = new Set<string>();
  file: Uint8Array = PNG;

  async call<T>(method: string, payload: Record<string, unknown>): Promise<T> {
    this.calls.push({ method, payload });
    if (this.failing.has(method)) throw new TelegramError("rejected", method, 400);
    if (method === "getFile") return { file_path: `photos/${payload.file_id}.jpg`, file_size: this.file.length } as T;
    return { message_id: 1000 + this.calls.length } as T;
  }

  async download(filePath: string): Promise<Uint8Array> {
    this.downloads.push(filePath);
    if (this.failing.has("download")) throw new TelegramError("network", "download");
    return this.file;
  }

  sent() {
    return this.calls.filter((c) => c.method === "sendMessage").map((c) => c.payload);
  }
  lastText(): string {
    return this.sent().at(-1)?.text ?? "";
  }
  buttons(): { text: string; callback_data: string }[] {
    return (this.sent().at(-1)?.reply_markup?.inline_keyboard ?? []).flat();
  }
  methods() {
    return this.calls.map((c) => c.method);
  }
}

let telegram = new FakeTelegram();

const config = {
  userDailyLimit: 100,
  appDailyLimit: 100_000,
  appPerMinuteLimit: 100_000,
  maxRounds: 5,
  requestTimeoutMs: 1000,
  receiptRequestTimeoutMs: 1000,
  deadlineMs: 2000,
  retryDelaysMs: [0, 0],
};

const app = createApp({
  makeDeps: (e) => ({ db: e.DB, llm, now: () => NOW, config }),
  telegram: { makeApi: () => telegram, secret: () => SECRET },
});

let nextUpdate = 1_000_000 + Math.floor(Math.random() * 1_000_000);
let nextUser = 5_000_000 + Math.floor(Math.random() * 1_000_000);
const newTelegramUser = () => nextUser++;

function post(update: Record<string, unknown>, headers: Record<string, string> = { "x-telegram-bot-api-secret-token": SECRET }) {
  return app.request(
    "/webhooks/telegram",
    { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(update) },
    env,
  );
}

const privateChat = (userId: number) => ({ id: userId, type: "private" });
const from = (userId: number) => ({ id: userId, is_bot: false, first_name: "Dana" });

/** Sends a message update for a fresh scripted model and a fresh Telegram recorder. */
async function message(userId: number, fields: Record<string, unknown>, ...steps: ConstructorParameters<typeof FakeLlm>) {
  llm = new FakeLlm(...steps);
  telegram = new FakeTelegram();
  const res = await post({ update_id: nextUpdate++, message: { message_id: 1, date: 0, chat: privateChat(userId), from: from(userId), ...fields } });
  return res;
}

async function press(userId: number, data: string, chat: Record<string, unknown> = privateChat(userId)) {
  llm = new FakeLlm();
  telegram = new FakeTelegram();
  return post({
    update_id: nextUpdate++,
    callback_query: { id: `cb-${nextUpdate}`, from: from(userId), data, message: { message_id: 77, date: 0, chat } },
  });
}

const prepare = (overrides: Record<string, unknown> = {}) =>
  call({
    name: "prepare_expense",
    args: { amount: 42, currency: "USD", category: "meals", merchant: "Cafe Nero", date: "2026-11-23", ...overrides },
  });

const receiptJson = (overrides: Record<string, unknown> = {}) =>
  say(
    JSON.stringify({
      image_kind: "receipt",
      merchant: "Cafe Aurora",
      total: 48.5,
      currency: "USD",
      currency_evidence: "code",
      date: "2026-11-23",
      category: "meals",
      description: null,
      ...overrides,
    }),
  );

const photo = { photo: [{ file_id: "small", width: 90, height: 120, file_size: 2000 }, { file_id: "large", width: 900, height: 1200, file_size: 90_000 }] };

async function dbUser(telegramId: number) {
  return findUser(env.DB, "telegram", String(telegramId));
}

async function countSubmitted(telegramId: number) {
  const user = await dbUser(telegramId);
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM expenses WHERE user_id = ? AND status = 'submitted'").bind(user!.id).first<{ n: number }>();
  return row!.n;
}

describe("webhook authentication", () => {
  it.each([
    ["no secret header", {}],
    ["a wrong secret", { "x-telegram-bot-api-secret-token": "guess" }],
    ["a secret that only starts the same", { "x-telegram-bot-api-secret-token": `${SECRET}x` }],
  ])("rejects a request with %s and does nothing", async (_label, headers) => {
    const user = newTelegramUser();
    llm = new FakeLlm();
    telegram = new FakeTelegram();

    const res = await post({ update_id: nextUpdate++, message: { message_id: 1, date: 0, chat: privateChat(user), from: from(user), text: "hi" } }, headers);

    expect(res.status).toBe(401);
    expect(telegram.calls).toEqual([]);
    expect(await dbUser(user)).toBeNull();
  });

  it("refuses everything when no webhook secret is configured", async () => {
    const open = createApp({
      makeDeps: (e) => ({ db: e.DB, llm, now: () => NOW, config }),
      telegram: { makeApi: () => telegram, secret: () => undefined },
    });
    telegram = new FakeTelegram();

    const res = await open.request("/webhooks/telegram", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }, env);

    expect(res.status).toBe(503);
    expect(telegram.calls).toEqual([]);
  });

  it("acknowledges a body it cannot use, so Telegram does not redeliver it forever", async () => {
    telegram = new FakeTelegram();
    const res = await app.request("/webhooks/telegram", { method: "POST", headers: { "x-telegram-bot-api-secret-token": SECRET }, body: "not json" }, env);
    expect(res.status).toBe(200);
    expect(telegram.calls).toEqual([]);
  });
});

describe("duplicate updates", () => {
  it("handles a redelivered update once", async () => {
    const user = newTelegramUser();
    llm = new FakeLlm(say("Hello."));
    telegram = new FakeTelegram();
    const update = { update_id: nextUpdate++, message: { message_id: 1, date: 0, chat: privateChat(user), from: from(user), text: "hi" } };

    await post(update);
    const again = await post(update);

    expect(again.status).toBe(200);
    expect(telegram.sent()).toHaveLength(1);
    expect(llm.requests).toHaveLength(1);
  });
});

describe("commands and first use", () => {
  it("welcomes a new user on /start with things to try, without calling the model", async () => {
    const user = newTelegramUser();

    await message(user, { text: "/start" });

    const text = telegram.lastText();
    expect(text).toContain("Snap. Chat. Submit.");
    expect(text).toMatch(/photo of a receipt/i);
    expect(text).toContain("I spent $42 on lunch at Cafe Nero yesterday");
    expect(text).toMatch(/fictional/i);
    expect(llm.requests).toHaveLength(0);
  });

  it("explains itself on /help, and on a command it does not know", async () => {
    const user = newTelegramUser();

    await message(user, { text: "/help" });
    expect(telegram.lastText()).toMatch(/\/confirm/);

    await message(user, { text: "/frobnicate" });
    expect(telegram.lastText()).toMatch(/\/help/);
    expect(llm.requests).toHaveLength(0);
  });

  it("accepts commands addressed to the bot by name", async () => {
    const user = newTelegramUser();
    await message(user, { text: "/start@GetExpensoBot" });
    expect(telegram.lastText()).toContain("Snap. Chat. Submit.");
  });
});

describe("text conversation", () => {
  it("shows typing, then answers", async () => {
    const user = newTelegramUser();

    await message(user, { text: "What is the meal limit?" }, say("The meal limit is $75."));

    expect(telegram.methods()).toEqual(["sendChatAction", "sendMessage"]);
    expect(telegram.calls[0]!.payload).toMatchObject({ chat_id: user, action: "typing" });
    expect(telegram.sent()[0]).toMatchObject({ chat_id: user, text: "The meal limit is $75." });
  });

  it("carries the earlier messages into a follow-up", async () => {
    const user = newTelegramUser();
    await message(user, { text: "I spent $42 on lunch yesterday" }, say("Which restaurant?"));

    await message(user, { text: "Cafe Nero" }, say("Thanks."));

    expect(JSON.stringify(llm.requests[0]!.messages)).toContain("I spent $42 on lunch yesterday");
  });

  it("previews a draft with its policy margin and buttons tied to that draft", async () => {
    const user = newTelegramUser();

    await message(user, { text: "$42 lunch at Cafe Nero yesterday" }, prepare(), say("Saved that for you."));

    const draft = await getActiveDraft(env.DB, (await dbUser(user))!.id);
    const text = telegram.lastText();
    expect(text).toContain("Saved that for you.");
    expect(text).toContain("Draft · not submitted");
    expect(text).toContain("$42.00");
    expect(text).toContain("Cafe Nero");
    expect(text).toContain("$33.00 under the $75.00 Meals limit");
    expect(telegram.buttons()).toEqual([
      { text: "Confirm and submit", callback_data: `c:${draft!.id}` },
      { text: "Discard", callback_data: `x:${draft!.id}` },
    ]);
    expect(await countSubmitted(user)).toBe(0);
  });

  it("says exactly how far over the limit an expense is", async () => {
    const user = newTelegramUser();

    await message(user, { text: "$140 dinner" }, prepare({ amount: 140, merchant: "Luigi's" }), say("Saved."));

    expect(telegram.lastText()).toContain("$65.00 over the $75.00 Meals limit");
    expect(telegram.lastText()).toMatch(/manual review/);
  });

  it("escapes characters that would break Telegram's formatting", async () => {
    const user = newTelegramUser();

    await message(user, { text: "lunch" }, prepare({ merchant: "Tom & Jerry's <Diner>" }), say("Saved <it> & done."));

    const sent = telegram.sent().at(-1)!;
    expect(sent.parse_mode).toBe("HTML");
    expect(sent.text).toContain("Tom &amp; Jerry's &lt;Diner&gt;");
    expect(sent.text).toContain("Saved &lt;it&gt; &amp; done.");
  });

  it("reports a correction as what changed", async () => {
    const user = newTelegramUser();
    await message(user, { text: "$42 lunch" }, prepare(), say("Saved."));

    await message(user, { text: "make it 48.50" }, prepare({ amount: 48.5 }), say("Updated."));

    expect(telegram.lastText()).toContain("Amount changed $42.00 → $48.50");
    expect(telegram.lastText()).toContain("$48.50");
  });
});

describe("confirm and discard buttons", () => {
  async function draftFor(user: number) {
    await message(user, { text: "$42 lunch" }, prepare(), say("Saved."));
    return (await getActiveDraft(env.DB, (await dbUser(user))!.id))!.id;
  }

  it("submits on Confirm, removes the buttons and returns a submission confirmation", async () => {
    const user = newTelegramUser();
    const id = await draftFor(user);

    await press(user, `c:${id}`);

    expect(telegram.methods()).toContain("answerCallbackQuery");
    expect(telegram.calls.find((c) => c.method === "editMessageReplyMarkup")?.payload).toMatchObject({
      chat_id: user,
      message_id: 77,
      reply_markup: { inline_keyboard: [] },
    });
    expect(telegram.lastText()).toContain("Submitted for processing");
    expect(telegram.lastText()).toContain("$42.00");
    expect(telegram.lastText()).not.toMatch(/approved/i);
    expect(telegram.buttons()).toEqual([]);
    expect(await countSubmitted(user)).toBe(1);
    expect(llm.requests).toHaveLength(0);
  });

  it("submits once when Confirm is pressed twice", async () => {
    const user = newTelegramUser();
    const id = await draftFor(user);
    await press(user, `c:${id}`);

    await press(user, `c:${id}`);

    expect(telegram.lastText()).toMatch(/already submitted/i);
    expect(await countSubmitted(user)).toBe(1);
  });

  it("refuses a button from before the draft was changed", async () => {
    const user = newTelegramUser();
    const oldId = await draftFor(user);
    await message(user, { text: "make it 45" }, prepare({ amount: 45 }), say("Updated."));

    await press(user, `c:${oldId}`);

    expect(telegram.lastText()).toMatch(/no longer active/i);
    expect(await countSubmitted(user)).toBe(0);
    expect((await getActiveDraft(env.DB, (await dbUser(user))!.id))?.amountCents).toBe(4500);
  });

  it("discards on Discard", async () => {
    const user = newTelegramUser();
    const id = await draftFor(user);

    await press(user, `x:${id}`);

    expect(telegram.lastText()).toMatch(/discarded/i);
    expect(await getActiveDraft(env.DB, (await dbUser(user))!.id)).toBeNull();
  });

  it("does not let one user's button act on another user's draft", async () => {
    const alice = newTelegramUser();
    const mallory = newTelegramUser();
    const id = await draftFor(alice);
    await message(mallory, { text: "/start" });

    await press(mallory, `c:${id}`);
    await press(mallory, `x:${id}`);

    expect(telegram.lastText()).toMatch(/couldn't find/i);
    expect(await countSubmitted(alice)).toBe(0);
    expect((await getActiveDraft(env.DB, (await dbUser(alice))!.id))?.id).toBe(id);
  });

  it.each(["c:abc", "c:-1", "c:1.5", "z:1", "", "c:"])("ignores malformed button data %j", async (data) => {
    const user = newTelegramUser();
    await draftFor(user);

    const res = await press(user, data);

    expect(res.status).toBe(200);
    expect(await countSubmitted(user)).toBe(0);
  });

  it.each(["confirm", "/confirm", "/confirm@GetExpensoBot"])("submits on the typed command %j without the model", async (text) => {
    const user = newTelegramUser();
    await draftFor(user);

    await message(user, { text });

    expect(llm.requests).toHaveLength(0);
    expect(telegram.lastText()).toContain("Submitted for processing");
    expect(await countSubmitted(user)).toBe(1);
  });

  it("does not treat 'yes' as a confirmation", async () => {
    const user = newTelegramUser();
    await draftFor(user);

    await message(user, { text: "yes" }, say('Please press Confirm or type "confirm".'));

    expect(await countSubmitted(user)).toBe(0);
  });
});

describe("receipt photos", () => {
  it("downloads the largest size of a photo and returns a draft preview", async () => {
    const user = newTelegramUser();

    await message(user, { ...photo, caption: "team lunch" }, receiptJson());

    expect(telegram.calls.find((c) => c.method === "getFile")?.payload).toEqual({ file_id: "large" });
    expect(telegram.downloads).toEqual(["photos/large.jpg"]);
    expect((llm.requests[0]!.messages[0] as { text: string }).text).toContain("team lunch");
    expect(telegram.lastText()).toContain("Draft · not submitted");
    expect(telegram.lastText()).toContain("$48.50");
    expect(telegram.lastText()).toContain("Cafe Aurora");
    expect(telegram.buttons().map((b) => b.text)).toEqual(["Confirm and submit", "Discard"]);
    expect(await countSubmitted(user)).toBe(0);
  });

  it("accepts an image sent as a file", async () => {
    const user = newTelegramUser();

    await message(user, { document: { file_id: "doc1", mime_type: "image/png", file_name: "receipt.png", file_size: 50_000 } }, receiptJson());

    expect(telegram.downloads).toEqual(["photos/doc1.jpg"]);
    expect(telegram.lastText()).toContain("Draft · not submitted");
  });

  it.each([
    ["a PDF", { document: { file_id: "d", mime_type: "application/pdf", file_name: "r.pdf", file_size: 1000 } }],
    ["a voice note", { voice: { file_id: "v", duration: 3 } }],
    ["a sticker", { sticker: { file_id: "s" } }],
    ["a video", { video: { file_id: "v", duration: 3 } }],
  ])("explains what it can read when sent %s, without downloading or calling the model", async (_label, fields) => {
    const user = newTelegramUser();

    await message(user, fields);

    expect(telegram.lastText()).toMatch(/JPEG or PNG/);
    expect(telegram.methods()).not.toContain("getFile");
    expect(llm.requests).toHaveLength(0);
  });

  it("refuses an oversized file before downloading it", async () => {
    const user = newTelegramUser();

    await message(user, { document: { file_id: "big", mime_type: "image/jpeg", file_name: "big.jpg", file_size: 9_000_000 } });

    expect(telegram.lastText()).toMatch(/too large/i);
    expect(telegram.methods()).not.toContain("getFile");
  });

  it("checks what was actually downloaded, whatever Telegram said it was", async () => {
    const user = newTelegramUser();
    llm = new FakeLlm();
    telegram = new FakeTelegram();
    telegram.file = new TextEncoder().encode("this is not an image");

    await post({ update_id: nextUpdate++, message: { message_id: 1, date: 0, chat: privateChat(user), from: from(user), ...photo } });

    expect(telegram.lastText()).toMatch(/JPEG or PNG/);
    expect(llm.requests).toHaveLength(0);
  });

  it("asks about a bare currency symbol with a button, and drafts once answered", async () => {
    const user = newTelegramUser();
    await message(user, photo, receiptJson({ currency_evidence: "symbol" }));
    expect(telegram.lastText()).toMatch(/currency/i);
    expect(telegram.buttons()).toContainEqual({ text: "Yes, USD", callback_data: "u:USD" });

    await press(user, "u:USD");

    expect(llm.requests).toHaveLength(0);
    expect(telegram.lastText()).toContain("Draft · not submitted");
    expect(telegram.buttons().map((b) => b.text)).toEqual(["Confirm and submit", "Discard"]);
  });

  it("says why a receipt is blocked by policy and offers no Confirm button", async () => {
    const user = newTelegramUser();

    await message(user, photo, receiptJson({ date: "2026-12-25" }));

    expect(telegram.lastText()).toContain("The expense date is in the future.");
    expect(telegram.buttons()).toEqual([]);
  });

  it("says so when the picture is not a receipt", async () => {
    const user = newTelegramUser();
    await message(user, photo, receiptJson({ image_kind: "not_a_receipt" }));
    expect(telegram.lastText()).toMatch(/doesn't look like a receipt/i);
  });
});

describe("private chats only", () => {
  it.each(["group", "supergroup", "channel"])("ignores messages in a %s", async (type) => {
    const user = newTelegramUser();
    llm = new FakeLlm();
    telegram = new FakeTelegram();

    const res = await post({ update_id: nextUpdate++, message: { message_id: 1, date: 0, chat: { id: -100123, type }, from: from(user), text: "hi" } });

    expect(res.status).toBe(200);
    expect(telegram.calls).toEqual([]);
    expect(await dbUser(user)).toBeNull();
  });

  it("ignores a button pressed in a group", async () => {
    const user = newTelegramUser();
    await message(user, { text: "$42 lunch" }, prepare(), say("Saved."));
    const id = (await getActiveDraft(env.DB, (await dbUser(user))!.id))!.id;

    await press(user, `c:${id}`, { id: -100123, type: "group" });

    expect(telegram.sent()).toEqual([]);
    expect(await countSubmitted(user)).toBe(0);
  });
});

describe("isolation and shared logic", () => {
  it("keeps two Telegram users' conversations and drafts apart", async () => {
    const alice = newTelegramUser();
    const bob = newTelegramUser();
    await message(alice, { text: "$42 lunch at Alice's Bistro" }, prepare({ merchant: "Alice's Bistro" }), say("Saved."));

    await message(bob, { text: "hello" }, say("Hi."));

    expect(JSON.stringify(llm.requests[0])).not.toContain("Alice's Bistro");
    expect(await getActiveDraft(env.DB, (await dbUser(bob))!.id)).toBeNull();
  });

  it("does not link a Telegram user to a web session", async () => {
    const user = newTelegramUser();
    await message(user, { text: "$42 lunch at Cafe Nero" }, prepare(), say("Saved."));

    const web = await app.request("/api/session", { method: "POST" }, env);

    expect(JSON.stringify((await web.json()) as Bootstrap)).not.toContain("Cafe Nero");
  });

  it("goes through the same assistant as the web app: same draft, same stored card", async () => {
    const tg = newTelegramUser();
    await message(tg, { text: "$42 lunch at Cafe Nero yesterday" }, prepare(), say("Saved."));
    const tgUser = (await dbUser(tg))!;

    const session = await app.request("/api/session", { method: "POST" }, env);
    const cookie = session.headers.get("set-cookie")!.split(";")[0]!;
    llm = new FakeLlm(prepare(), say("Saved."));
    const webTurn = await app.request("/api/chat", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ text: "$42 lunch at Cafe Nero yesterday" }) }, env);
    const webDraft = ((await webTurn.json()) as { desk: { currentSlip: Record<string, unknown> } }).desk.currentSlip;

    const tgDraft = (await getActiveDraft(env.DB, tgUser.id))!;
    const same = (e: Record<string, unknown>) => [e.amountCents, e.merchant, e.category, e.expenseDate, e.status, e.policyResult];
    expect(same(tgDraft as unknown as Record<string, unknown>)).toEqual(same(webDraft));

    const meta = await env.DB.prepare("SELECT meta FROM messages WHERE user_id = ? AND role = 'assistant' ORDER BY id DESC LIMIT 1").bind(tgUser.id).first<{ meta: string }>();
    expect(JSON.parse(meta!.meta)).toMatchObject({ card: { kind: "expense", event: "drafted", expenseId: tgDraft.id } });
  });
});

describe("failures", () => {
  it("gives a friendly message when the AI service rate-limits us", async () => {
    const user = newTelegramUser();

    await message(user, { text: "hi" }, new LlmError("rate_limited", { status: 429 }));

    expect(telegram.lastText()).toMatch(/try again/i);
    expect(telegram.lastText()).not.toMatch(/429|LlmError/);
  });

  it("says the daily limit was reached", async () => {
    const limited = createApp({
      makeDeps: (e) => ({ db: e.DB, llm: new FakeLlm(), now: () => NOW, config: { ...config, userDailyLimit: 0 } }),
      telegram: { makeApi: () => telegram, secret: () => SECRET },
    });
    const user = newTelegramUser();
    telegram = new FakeTelegram();

    await limited.request("/webhooks/telegram", { method: "POST", headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": SECRET }, body: JSON.stringify({ update_id: nextUpdate++, message: { message_id: 1, date: 0, chat: privateChat(user), from: from(user), text: "hi" } }) }, env);

    expect(telegram.lastText()).toMatch(/daily limit/i);
  });

  it("says the photo could not be fetched when Telegram's file download fails", async () => {
    const user = newTelegramUser();
    llm = new FakeLlm();
    telegram = new FakeTelegram();
    telegram.failing.add("download");

    await post({ update_id: nextUpdate++, message: { message_id: 1, date: 0, chat: privateChat(user), from: from(user), ...photo } });

    expect(telegram.lastText()).toMatch(/couldn't download/i);
    expect(llm.requests).toHaveLength(0);
  });

  it("still answers 200 and tells the user when something unexpected breaks", async () => {
    const user = newTelegramUser();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    llm = new FakeLlm();
    telegram = new FakeTelegram();
    telegram.failing.add("getFile");

    const res = await post({ update_id: nextUpdate++, message: { message_id: 1, date: 0, chat: privateChat(user), from: from(user), ...photo } });

    expect(res.status).toBe(200);
    expect(telegram.lastText()).toMatch(/couldn't download|went wrong/i);
    errors.mockRestore();
  });

  it("does not fail the webhook when Telegram refuses our reply", async () => {
    const user = newTelegramUser();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    llm = new FakeLlm(say("Hello."));
    telegram = new FakeTelegram();
    telegram.failing.add("sendMessage");

    const res = await post({ update_id: nextUpdate++, message: { message_id: 1, date: 0, chat: privateChat(user), from: from(user), text: "hi" } });

    expect(res.status).toBe(200);
    errors.mockRestore();
  });
});

describe("Telegram API client", () => {
  const TOKEN = "123456789:test-token-do-not-leak";

  it("posts JSON to the method's URL and returns the result", async () => {
    let seen: { url: string; body: unknown } | undefined;
    const api = createTelegramApi({
      token: TOKEN,
      fetch: (async (url: RequestInfo | URL, init?: RequestInit) => {
        seen = { url: String(url), body: JSON.parse(String(init?.body)) };
        return new Response(JSON.stringify({ ok: true, result: { message_id: 5 } }));
      }) as typeof fetch,
    });

    const result = await api.call<{ message_id: number }>("sendMessage", { chat_id: 1, text: "hi" });

    expect(result).toEqual({ message_id: 5 });
    expect(seen).toEqual({ url: `https://api.telegram.org/bot${TOKEN}/sendMessage`, body: { chat_id: 1, text: "hi" } });
  });

  it("never puts the token, or Telegram's own error text, in an error", async () => {
    const api = createTelegramApi({
      token: TOKEN,
      fetch: (async () => new Response(JSON.stringify({ ok: false, description: `Unauthorized for bot${TOKEN}` }), { status: 401 })) as typeof fetch,
    });

    const error = await api.call("getMe", {}).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(TelegramError);
    expect((error as TelegramError).status).toBe(401);
    expect(`${(error as Error).message} ${JSON.stringify(error)} ${(error as Error).stack}`).not.toContain(TOKEN);
  });

  it("reports a network failure without the URL", async () => {
    const api = createTelegramApi({
      token: TOKEN,
      fetch: (async () => {
        throw new TypeError(`fetch failed: https://api.telegram.org/bot${TOKEN}/getFile`);
      }) as unknown as typeof fetch,
    });

    const error = (await api.call("getFile", {}).catch((e: unknown) => e)) as TelegramError;

    expect(error.kind).toBe("network");
    expect(error.message).not.toContain(TOKEN);
  });

  it("downloads a file, and refuses one larger than allowed", async () => {
    const api = createTelegramApi({
      token: TOKEN,
      fetch: (async (url: RequestInfo | URL) => {
        expect(String(url)).toBe(`https://api.telegram.org/file/bot${TOKEN}/photos/a.jpg`);
        return new Response(PNG, { headers: { "content-length": String(PNG.length) } });
      }) as typeof fetch,
    });

    expect(await api.download("photos/a.jpg", 1000)).toEqual(PNG);
    await expect(api.download("photos/a.jpg", 4)).rejects.toMatchObject({ kind: "too_large" });
  });

  it("refuses a file path that tries to leave the bot's file area", async () => {
    const api = createTelegramApi({ token: TOKEN, fetch: (async () => new Response("x")) as typeof fetch });
    await expect(api.download("../../etc/passwd", 1000)).rejects.toBeInstanceOf(TelegramError);
  });
});

import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import type { Bootstrap, LinkPreviewDto, TurnResult } from "../../shared/contract";
import { createApp } from "../src/index";
import {
  APP_FAILURE_LIMIT,
  BROWSER_FAILURE_LIMIT,
  findHandoff,
  issueHandoff,
  normalizeCode,
  redeemHandoff,
  validWebUrl,
} from "../src/services/handoff";
import { sha256Hex } from "../src/services/sessions";
import { quotaDay } from "../src/lib/dates";
import { getActiveDraft } from "../src/services/expenses";
import { findOrCreateUser, findUser } from "../src/services/users";
import { FakeLlm, call, say } from "./fake-llm";
import { FakeTelegram, PNG } from "./fake-telegram";

const SECRET = "test-webhook-secret";
const KEY = "test-code-key";
const WEB = "https://expenso.test";

let clock = new Date("2026-11-24T10:00:00Z");
let llm = new FakeLlm();
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
  makeDeps: (e) => ({ db: e.DB, llm, now: () => clock, config }),
  telegram: { makeApi: () => telegram, secret: () => SECRET },
  channels: { linkKey: () => KEY, webUrl: () => WEB, telegramApi: () => telegram },
});

let nextUpdate = 3_000_000 + Math.floor(Math.random() * 1_000_000);
let nextTelegramUser = 7_000_000 + Math.floor(Math.random() * 1_000_000);

const prepare = (overrides: Record<string, unknown> = {}) =>
  call({
    name: "prepare_expense",
    args: { amount: 48.5, currency: "USD", category: "meals", merchant: "Cafe Aurora", date: "2026-11-23", ...overrides },
  });

/** A Telegram user talking to the bot. */
class TelegramUser {
  readonly id = nextTelegramUser++;

  async say(text: string, ...steps: ConstructorParameters<typeof FakeLlm>) {
    llm = new FakeLlm(...steps);
    telegram = new FakeTelegram();
    await this.update({ message: { message_id: 1, date: 0, chat: { id: this.id, type: "private" }, from: { id: this.id, first_name: "Dana" }, text } });
    return telegram;
  }

  async photo(...steps: ConstructorParameters<typeof FakeLlm>) {
    llm = new FakeLlm(...steps);
    telegram = new FakeTelegram();
    await this.update({
      message: { message_id: 1, date: 0, chat: { id: this.id, type: "private" }, from: { id: this.id, first_name: "Dana" }, photo: [{ file_id: "p", file_size: 1000 }] },
    });
    return telegram;
  }

  async press(data: string) {
    llm = new FakeLlm();
    telegram = new FakeTelegram();
    await this.update({
      callback_query: { id: "cb", from: { id: this.id, first_name: "Dana" }, data, message: { message_id: 9, date: 0, chat: { id: this.id, type: "private" } } },
    });
    return telegram;
  }

  update(fields: Record<string, unknown>) {
    return app.request(
      "/webhooks/telegram",
      { method: "POST", headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": SECRET }, body: JSON.stringify({ update_id: nextUpdate++, ...fields }) },
      env,
    );
  }

  /** Asks the bot for a link and a code, and returns them as the bot sent them. */
  async handoff(): Promise<{ token: string; code: string; text: string; url: string }> {
    const tg = await this.say("/web");
    const sent = tg.sent().at(-1)!;
    const url = (tg.buttons().find((b) => b.url)?.url ?? "") as string;
    return { token: url.split("#link=")[1] ?? "", code: /<code>([A-Z0-9-]+)<\/code>/.exec(sent.text)![1]!, text: sent.text, url };
  }

  async account() {
    return (await findUser(env.DB, "telegram", String(this.id)))!;
  }
}

/** A browser with a cookie jar. */
class Browser {
  cookies = new Map<string, string>();

  async request(path: string, init: RequestInit = {}) {
    const cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    const res = await app.request(path, { ...init, headers: { ...(cookie ? { cookie } : {}), ...(init.headers ?? {}) } }, env);
    for (const line of res.headers.getSetCookie()) {
      const [pair] = line.split(";");
      const [name, value] = pair!.split("=") as [string, string];
      if (!value || /Max-Age=0/i.test(line)) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    return res;
  }

  post(path: string, body?: unknown) {
    return this.request(path, {
      method: "POST",
      ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    });
  }

  async open(): Promise<Bootstrap> {
    return (await this.post("/api/session")).json();
  }

  async chat(text: string, ...steps: ConstructorParameters<typeof FakeLlm>): Promise<TurnResult> {
    llm = new FakeLlm(...steps);
    return (await this.post("/api/chat", { text })).json();
  }
}

/** A browser that has opened the app as a guest. */
async function guest() {
  const browser = new Browser();
  await browser.open();
  return browser;
}

/** A Telegram user with a draft, and a browser connected to that account. */
async function connected() {
  const tg = new TelegramUser();
  await tg.say("I spent $48.50 at Cafe Aurora yesterday", prepare(), say("Saved."));
  const browser = await guest();
  const { token } = await tg.handoff();
  const res = await browser.post("/api/link/redeem", { token });
  expect(res.status).toBe(200);
  return { tg, browser, bootstrap: (await res.json()) as Bootstrap };
}

async function submittedCount(userId: number) {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM expenses WHERE user_id = ? AND status = 'submitted'").bind(userId).first<{ n: number }>();
  return row!.n;
}

const notices = () => telegram.sent().filter((m) => /on the web/.test(m.text));

describe("Telegram offers the web", () => {
  it("answers /web with a one-time link and a code, and tells the user not to forward them", async () => {
    const tg = new TelegramUser();

    const { token, code, text, url } = await tg.handoff();

    expect(url.startsWith(`${WEB}/#link=`)).toBe(true);
    expect(url).not.toContain("?");
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    expect(text).toMatch(/expire in 10 minutes/);
    expect(text).toMatch(/Don't forward/);
    expect(telegram.sent().at(-1)!.link_preview_options).toEqual({ is_disabled: true });
  });

  it("puts Continue on web under a draft preview", async () => {
    const tg = new TelegramUser();

    const sent = await tg.say("$48.50 at Cafe Aurora", prepare(), say("Saved."));

    const buttons = sent.buttons();
    expect(buttons.map((b) => b.text)).toEqual(["Confirm and submit", "Discard", "Continue on web ↗"]);
    expect(buttons[2]!.url).toMatch(new RegExp(`^${WEB}/#link=[A-Za-z0-9_-]{43}$`));
  });

  it("stores neither the link token nor the code, and keys the code hash", async () => {
    const tg = new TelegramUser();
    const { token, code } = await tg.handoff();

    const row = await env.DB.prepare("SELECT link_hash, code_hash FROM handoff_tokens WHERE user_id = ? ORDER BY id DESC LIMIT 1").bind((await tg.account()).id).first<{ link_hash: string; code_hash: string }>();

    expect(JSON.stringify(row)).not.toContain(token);
    expect(JSON.stringify(row)).not.toContain(code.replace("-", ""));
    expect(row!.link_hash).toBe(await sha256Hex(token));
    expect(row!.code_hash).not.toBe(await sha256Hex(code.replace("-", "")));
  });
});

describe("opening the link", () => {
  it("previews whose account it is without using the link", async () => {
    const tg = new TelegramUser();
    const { token } = await tg.handoff();
    const browser = await guest();

    const first = (await (await browser.post("/api/link/preview", { token })).json()) as LinkPreviewDto;
    await browser.post("/api/link/preview", { token });
    const redeemed = await browser.post("/api/link/redeem", { token });

    expect(first).toEqual({ name: "Dana", sameAccount: false, guest: { submitted: 0, hasDraft: false, messages: 0 } });
    expect(redeemed.status).toBe(200);
  });

  it("opens the same conversation, the same draft and the same ledger", async () => {
    const { tg, bootstrap } = await connected();
    const draft = await getActiveDraft(env.DB, (await tg.account()).id);

    expect(bootstrap.account).toEqual({ kind: "telegram", name: "Dana", returnsToGuest: false });
    expect(bootstrap.desk.currentSlip?.id).toBe(draft!.id);
    expect(bootstrap.messages.map((m) => [m.role, m.via ?? "web"])).toEqual([
      ["user", "telegram"],
      ["assistant", "web"],
    ]);
    expect(bootstrap.messages[0]!.text).toBe("I spent $48.50 at Cafe Aurora yesterday");
  });

  it("gives the browser a brand-new session, never the one it had", async () => {
    const tg = new TelegramUser();
    const browser = await guest();
    const before = browser.cookies.get("expenso_session");

    await browser.post("/api/link/redeem", { token: (await tg.handoff()).token });

    expect(browser.cookies.get("expenso_session")).toBeTruthy();
    expect(browser.cookies.get("expenso_session")).not.toBe(before);
  });

  it("works once: a second use, from any browser, is refused", async () => {
    const tg = new TelegramUser();
    const { token } = await tg.handoff();
    await (await guest()).post("/api/link/redeem", { token });

    const again = await (await guest()).post("/api/link/redeem", { token });

    expect(again.status).toBe(410);
    expect(await again.json()).toMatchObject({ error: { code: "link_used" } });
  });

  it("expires after ten minutes", async () => {
    const tg = new TelegramUser();
    const { token } = await tg.handoff();
    clock = new Date(clock.getTime() + 10 * 60_000 + 1);

    const res = await (await guest()).post("/api/link/redeem", { token });
    clock = new Date("2026-11-24T10:00:00Z");

    expect(res.status).toBe(410);
    expect(await res.json()).toMatchObject({ error: { code: "link_expired" } });
  });

  it.each([["an unknown token", "A".repeat(43)], ["a malformed token", "not a token"], ["a non-string", 42]])("refuses %s", async (_label, token) => {
    const res = await (await guest()).post("/api/link/redeem", { token });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: { code: "link_invalid" } });
  });

  it("lets exactly one of two simultaneous redemptions win", async () => {
    const tg = new TelegramUser();
    const { token } = await tg.handoff();
    const [a, b] = await Promise.all([guest(), guest()]);

    const results = await Promise.all([a.post("/api/link/redeem", { token }), b.post("/api/link/redeem", { token })]);

    expect(results.map((r) => r.status).sort()).toEqual([200, 410]);
    const sessions = await env.DB.prepare("SELECT COUNT(*) AS n FROM web_sessions WHERE user_id = ?").bind((await tg.account()).id).first<{ n: number }>();
    expect(sessions!.n).toBe(1);
  });

  it("leaves the link usable if creating the session fails", async () => {
    const tg = new TelegramUser();
    await tg.say("/start");
    const user = await tg.account();
    const ticket = await issueHandoff(env.DB, user.id, KEY, clock);
    const found = await findHandoff(env.DB, { token: ticket.token }, KEY, clock);
    if (found.status !== "valid") throw new Error("expected a valid ticket");
    // A session hash that already exists makes the session insert fail inside the transaction.
    const taken = await sha256Hex("an-existing-session");
    await env.DB.prepare("INSERT INTO web_sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)").bind(taken, user.id, "2099-01-01T00:00:00.000Z").run();

    await expect(redeemHandoff(env.DB, found.id, taken, clock)).rejects.toThrow();

    expect((await findHandoff(env.DB, { token: ticket.token }, KEY, clock)).status).toBe("valid");
  });

  it("never logs the token", async () => {
    const tg = new TelegramUser();
    const spies = (["log", "warn", "error", "info"] as const).map((level) => vi.spyOn(console, level).mockImplementation(() => {}));
    const { token, code } = await tg.handoff();
    const browser = await guest();
    await browser.post("/api/link/preview", { token });
    await browser.post("/api/link/redeem", { token });
    await browser.post("/api/link/redeem", { token });

    const logged = JSON.stringify(spies.map((s) => s.mock.calls));
    spies.forEach((s) => s.mockRestore());
    expect(logged).not.toContain(token);
    expect(logged).not.toContain(code);
  });
});

describe("the typed code", () => {
  it("connects a computer without Telegram, forgiving case and spacing", async () => {
    const tg = new TelegramUser();
    await tg.say("$48.50 at Cafe Aurora", prepare(), say("Saved."));
    const { code } = await tg.handoff();
    const laptop = await guest();

    const res = await laptop.post("/api/link/redeem", { code: ` ${code.toLowerCase().replace("-", " ")} ` });

    expect(res.status).toBe(200);
    expect(((await res.json()) as Bootstrap).desk.currentSlip?.merchant).toBe("Cafe Aurora");
  });

  it("stops a browser after too many wrong codes, even when the next one is right", async () => {
    const tg = new TelegramUser();
    const { code } = await tg.handoff();
    const browser = await guest();
    for (let i = 0; i < BROWSER_FAILURE_LIMIT; i++) {
      expect((await browser.post("/api/link/preview", { code: "ZZZZ-ZZZZ" })).status).toBe(404);
    }

    const res = await browser.post("/api/link/redeem", { code });

    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ error: { code: "too_many_attempts" } });
  });

  it("stops everyone once the whole app has seen too many wrong codes, so new browsers can't keep guessing", async () => {
    const tg = new TelegramUser();
    const { code } = await tg.handoff();
    const later = new Date("2031-06-01T12:00:00Z");
    const day = quotaDay(later);
    clock = later;
    await env.DB.prepare("INSERT INTO usage_daily (day, scope, count) VALUES (?, 'link_fail:app', ?)").bind(day, APP_FAILURE_LIMIT).run();

    const res = await (await guest()).post("/api/link/preview", { code });
    clock = new Date("2026-11-24T10:00:00Z");

    expect(res.status).toBe(429);
  });

  it.each([["I L O 1 lookalikes", "IL01-IL01", null], ["too short", "ABC", null], ["a valid one", "k7qm-4xpd", "K7QM4XPD"], ["O read as zero", "KOQM4XPD", "K0QM4XPD"]])(
    "normalises %s",
    (_label, input, expected) => {
      expect(normalizeCode(input)).toBe(expected);
    },
  );
});

describe("which account a browser opens", () => {
  it("refuses to switch a browser to a different Telegram account without disconnecting first", async () => {
    const { browser } = await connected();
    const other = new TelegramUser();
    await other.say("/start");

    const res = await browser.post("/api/link/redeem", { token: (await other.handoff()).token });

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: { code: "already_connected" } });
    expect((await browser.open()).account).toMatchObject({ kind: "telegram" });
  });

  it("simply continues when the link is for the account the browser already has, and spends the link", async () => {
    const { tg, browser } = await connected();
    const before = browser.cookies.get("expenso_session");
    const { token } = await tg.handoff();

    const res = await browser.post("/api/link/redeem", { token });

    expect(res.status).toBe(200);
    expect(browser.cookies.get("expenso_session")).toBe(before);
    expect((await (await guest()).post("/api/link/redeem", { token })).status).toBe(410);
  });

  it("keeps a guest workspace that holds anything, says so first, and brings it back on Disconnect", async () => {
    const tg = new TelegramUser();
    await tg.say("/start");
    const browser = await guest();
    await browser.chat("$12 coffee at Bean There", prepare({ amount: 12, merchant: "Bean There" }), say("Saved."));
    const { token } = await tg.handoff();

    const preview = (await (await browser.post("/api/link/preview", { token })).json()) as LinkPreviewDto;
    const linked = (await (await browser.post("/api/link/redeem", { token })).json()) as Bootstrap;

    expect(preview.guest).toEqual({ submitted: 0, hasDraft: true, messages: 2 });
    expect(linked.account).toEqual({ kind: "telegram", name: "Dana", returnsToGuest: true });
    expect(JSON.stringify(linked)).not.toContain("Bean There");

    const back = (await (await browser.post("/api/session/disconnect")).json()) as Bootstrap;

    expect(back.account).toEqual({ kind: "guest" });
    expect(back.desk.currentSlip?.merchant).toBe("Bean There");
    expect(browser.cookies.has("expenso_guest")).toBe(false);
  });

  it("starts a fresh guest on Disconnect when there was nothing to keep", async () => {
    const { browser } = await connected();

    const back = (await (await browser.post("/api/session/disconnect")).json()) as Bootstrap;

    expect(back.account).toEqual({ kind: "guest" });
    expect(back.messages).toEqual([]);
    expect(back.desk.currentSlip).toBeNull();
  });

  it("does not let a guest 'disconnect'", async () => {
    const res = await (await guest()).post("/api/session/disconnect");
    expect(res.status).toBe(409);
  });

  it("keeps two Telegram accounts apart on the web", async () => {
    const { browser } = await connected();
    const other = new TelegramUser();
    await other.say("$90 hotel at Other Inn", prepare({ amount: 90, merchant: "Other Inn", category: "lodging" }), say("Saved."));

    expect(JSON.stringify(await browser.open())).not.toContain("Other Inn");
  });
});

describe("/signout", () => {
  it("signs every browser out and kills links not yet used", async () => {
    const { tg, browser } = await connected();
    const laptop = await guest();
    await laptop.post("/api/link/redeem", { code: (await tg.handoff()).code });
    const unused = await tg.handoff();

    const reply = await tg.say("/signout");

    expect(reply.lastText()).toMatch(/Signed out of 2 browsers/);
    llm = new FakeLlm();
    expect((await browser.post("/api/chat", { text: "hi" })).status).toBe(401);
    expect((await laptop.open()).account).toEqual({ kind: "guest" });
    expect((await (await guest()).post("/api/link/redeem", { token: unused.token })).status).toBe(404);
  });
});

describe("one conversation across both channels", () => {
  it("tells Telegram once when an expense is submitted on the web", async () => {
    const { tg, browser, bootstrap } = await connected();
    const id = bootstrap.desk.currentSlip!.id;
    telegram = new FakeTelegram();

    await browser.post(`/api/expenses/${id}/confirm`);
    const repeated = await browser.post(`/api/expenses/${id}/confirm`);

    expect(repeated.status).toBe(200);
    expect(((await repeated.json()) as TurnResult).messages[0]!.text).toMatch(/already submitted/i);
    expect(notices()).toHaveLength(1);
    expect(notices()[0]).toMatchObject({ chat_id: tg.id, parse_mode: "HTML" });
    expect(notices()[0]!.text).toContain("Submitted on the web");
    expect(notices()[0]!.text).toContain("$48.50");
  });

  it("keeps the submission when the Telegram notice fails", async () => {
    const { tg, browser, bootstrap } = await connected();
    telegram = new FakeTelegram();
    telegram.failing.add("sendMessage");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const res = await browser.post(`/api/expenses/${bootstrap.desk.currentSlip!.id}/confirm`);
    warn.mockRestore();

    expect(res.status).toBe(200);
    expect(await submittedCount((await tg.account()).id)).toBe(1);
  });

  it("says nothing to Telegram about a guest's expenses", async () => {
    const browser = await guest();
    const turn = await browser.chat("$12 coffee", prepare({ amount: 12 }), say("Saved."));
    telegram = new FakeTelegram();

    await browser.post(`/api/expenses/${turn.desk.currentSlip!.id}/confirm`);

    expect(telegram.calls).toEqual([]);
  });

  it("refuses the old Telegram button after the expense was corrected and submitted on the web", async () => {
    const { tg, browser, bootstrap } = await connected();
    const oldId = bootstrap.desk.currentSlip!.id;
    const corrected = await browser.chat("the total was actually $82", prepare({ amount: 82 }), say("Updated."));
    await browser.post(`/api/expenses/${corrected.desk.currentSlip!.id}/confirm`);

    const reply = await tg.press(`c:${oldId}`);

    expect(reply.lastText()).toMatch(/no longer active/i);
    expect(await submittedCount((await tg.account()).id)).toBe(1);
  });

  it("submits once when the web and a Telegram button confirm at the same moment", async () => {
    const { tg, browser, bootstrap } = await connected();
    const id = bootstrap.desk.currentSlip!.id;
    telegram = new FakeTelegram();
    const shared = telegram;

    await Promise.all([browser.post(`/api/expenses/${id}/confirm`), tg.update({ callback_query: { id: "cb", from: { id: tg.id }, data: `c:${id}`, message: { message_id: 9, chat: { id: tg.id, type: "private" } } } })]);

    expect(await submittedCount((await tg.account()).id)).toBe(1);
    expect(shared.sent().filter((m) => /on the web/.test(m.text)).length).toBeLessThanOrEqual(1);
  });

  it("ends with exactly one draft when both channels correct it at once", async () => {
    const { tg, browser } = await connected();
    llm = new FakeLlm(prepare({ amount: 60 }), say("Updated."), prepare({ amount: 70 }), say("Updated."));
    telegram = new FakeTelegram();

    await Promise.all([
      browser.post("/api/chat", { text: "make it $60" }),
      tg.update({ message: { message_id: 2, date: 0, chat: { id: tg.id, type: "private" }, from: { id: tg.id }, text: "make it $70" } }),
    ]);

    const drafts = await env.DB.prepare("SELECT COUNT(*) AS n FROM expenses WHERE user_id = ? AND status = 'draft'").bind((await tg.account()).id).first<{ n: number }>();
    expect(drafts!.n).toBe(1);
  });

  it("shows on the web a receipt that Telegram read only in part", async () => {
    const tg = new TelegramUser();
    telegram = new FakeTelegram();
    telegram.file = PNG;
    await tg.photo(say(JSON.stringify({ image_kind: "receipt", merchant: "Cafe Aurora", total: 48.5, currency: "USD", currency_evidence: "code", date: null, category: "meals", description: null })));
    const browser = await guest();

    const res = await browser.post("/api/link/redeem", { token: (await tg.handoff()).token });
    const body = (await res.json()) as Bootstrap;

    expect(body.desk.pendingReceipt).toMatchObject({ status: "needs_details", missing: ["date"] });
    expect(body.messages[0]).toMatchObject({ role: "user", attachment: "receipt_photo", via: "telegram" });
  });

  it("lets Telegram answer about what was done on the web", async () => {
    const { tg, browser, bootstrap } = await connected();
    await browser.post(`/api/expenses/${bootstrap.desk.currentSlip!.id}/confirm`);

    await tg.say("how much this month?", call({ name: "get_spending_summary", args: { from: "2026-11-01", to: "2026-11-30" } }), say("You submitted $48.50."));

    expect(llm.requests[1]!.messages.some((m) => m.role === "tool_results" && JSON.stringify(m).includes("$48.50"))).toBe(true);
  });
});

describe("public address for links", () => {
  it.each([
    ["https://expenso.example.workers.dev", "https://expenso.example.workers.dev"],
    ["https://expenso.example.workers.dev/", "https://expenso.example.workers.dev"],
    ["http://localhost:8787", "http://localhost:8787"],
    ["http://expenso.example.com", null],
    ["https://user:pass@expenso.example.com", null],
    ["https://expenso.example.com/?x=1", null],
    ["javascript:alert(1)", null],
    ["", null],
    [undefined, null],
  ])("accepts %j as %j", (input, expected) => {
    expect(validWebUrl(input)).toBe(expected);
  });

  it("offers only the code when no public address is configured", async () => {
    const noUrl = createApp({
      makeDeps: (e) => ({ db: e.DB, llm, now: () => clock, config }),
      telegram: { makeApi: () => telegram, secret: () => SECRET },
      channels: { linkKey: () => KEY, webUrl: () => null, telegramApi: () => telegram },
    });
    const id = nextTelegramUser++;
    await findOrCreateUser(env.DB, { channel: "telegram", externalId: String(id) });
    telegram = new FakeTelegram();

    await noUrl.request("/webhooks/telegram", { method: "POST", headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": SECRET }, body: JSON.stringify({ update_id: nextUpdate++, message: { message_id: 1, date: 0, chat: { id, type: "private" }, from: { id }, text: "/web" } }) }, env);

    expect(telegram.buttons()).toEqual([]);
    expect(telegram.lastText()).toMatch(/<code>[A-Z0-9]{4}-[A-Z0-9]{4}<\/code>/);
  });
});

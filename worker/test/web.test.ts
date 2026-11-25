import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Bootstrap, PolicyCheckDto, PolicyDto, TurnResult } from "../../shared/contract";
import { createApp } from "../src/index";
import { LlmError } from "../src/llm/types";
import { FakeLlm, call, say } from "./fake-llm";

const NOW = new Date("2026-11-24T10:00:00Z");
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

/** The model for the next request; each test scripts its own. */
let llm = new FakeLlm();

const app = createApp({
  makeDeps: (e) => ({
    db: e.DB,
    llm,
    now: () => NOW,
    config: {
      userDailyLimit: 100,
      appDailyLimit: 100_000,
      appPerMinuteLimit: 100_000,
      maxRounds: 5,
      requestTimeoutMs: 1000,
      receiptRequestTimeoutMs: 1000,
      deadlineMs: 2000,
      retryDelaysMs: [0, 0],
    },
  }),
  channels: { linkKey: () => "test-code-key", webUrl: () => null, telegramApi: () => null },
});

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

/** A fresh browser: creates a session and returns its cookie. */
async function browser() {
  const res = await app.request("/api/session", { method: "POST" }, env);
  const setCookie = res.headers.get("set-cookie") ?? "";
  const cookie = setCookie.split(";")[0]!;

  const send = (path: string, init: RequestInit = {}) =>
    app.request(path, { ...init, headers: { cookie, ...(init.headers ?? {}) } }, env);
  const post = (path: string, body?: unknown) =>
    send(path, {
      method: "POST",
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const chat = async (text: string, ...steps: ConstructorParameters<typeof FakeLlm>) => {
    llm = new FakeLlm(...steps);
    return (await (await post("/api/chat", { text })).json()) as TurnResult;
  };
  const upload = (file: Blob, caption?: string) => {
    const form = new FormData();
    form.set("image", file, "receipt");
    if (caption) form.set("caption", caption);
    return send("/api/receipts", { method: "POST", body: form });
  };
  const reload = async () => (await (await post("/api/session")).json()) as Bootstrap;

  return { res, setCookie, cookie, send, post, chat, upload, reload, first: (await res.clone().json()) as Bootstrap };
}

describe("session", () => {
  it("starts an empty workspace and sets a cookie scripts cannot read", async () => {
    const b = await browser();

    expect(b.res.status).toBe(200);
    expect(b.setCookie).toMatch(/^expenso_session=[\w-]{40,}/);
    expect(b.setCookie).toMatch(/HttpOnly/i);
    expect(b.setCookie).toMatch(/SameSite=Lax/i);
    expect(b.setCookie).toMatch(/Path=\//);
    expect(b.first).toMatchObject({
      messages: [],
      desk: {
        currentSlip: null,
        pendingReceipt: null,
        recent: [],
        month: { from: "2026-11-01", to: "2026-11-24", summary: { totalCents: 0, count: 0 } },
      },
    });
  });

  it("marks the cookie Secure when served over HTTPS", async () => {
    const res = await app.request("https://expenso.example/api/session", { method: "POST" }, env);
    expect(res.headers.get("set-cookie")).toMatch(/Secure/i);
  });

  it("keeps the same workspace on a later visit and does not issue a new cookie", async () => {
    const b = await browser();
    await b.chat("hello", say("Hi there."));

    const again = await b.post("/api/session");

    expect(again.headers.get("set-cookie")).toBeNull();
    expect(((await again.json()) as Bootstrap).messages.map((m) => m.text)).toEqual(["hello", "Hi there."]);
  });

  it("stores only a hash of the session token", async () => {
    const b = await browser();
    const token = b.cookie.split("=")[1]!;

    const { results } = await env.DB.prepare("SELECT external_id FROM users WHERE channel = 'web'").all<{ external_id: string }>();

    expect(results.some((r) => r.external_id.includes(token))).toBe(false);
  });

  it.each([
    ["no cookie", {}],
    ["an unknown session", { cookie: "expenso_session=not-a-real-session-token-0000000000000000000000" }],
  ])("refuses protected routes with %s", async (_label, headers) => {
    const res = await app.request("/api/chat", { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ text: "hi" }) }, env);
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: { code: "no_session" } });
  });

  it("refuses a state-changing request sent from another site", async () => {
    const b = await browser();

    const res = await b.send("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://evil.example", host: "expenso.example" },
      body: JSON.stringify({ text: "hi" }),
    });

    expect(res.status).toBe(403);
  });

  it("sends basic security headers with API responses", async () => {
    const b = await browser();
    expect(b.res.headers.get("x-content-type-options")).toBe("nosniff");
  });
});

describe("chat", () => {
  it("returns the messages of the turn and the updated desk", async () => {
    const b = await browser();

    const result = await b.chat("$42 lunch at Cafe Nero yesterday", prepare(), say("Saved that for you."));

    expect(result.messages.map((m) => [m.role, m.text])).toEqual([
      ["user", "$42 lunch at Cafe Nero yesterday"],
      ["assistant", "Saved that for you."],
    ]);
    expect(result.messages[1]!.card).toMatchObject({
      kind: "expense",
      event: "drafted",
      expense: { amountCents: 4200, merchant: "Cafe Nero", status: "draft", policyResult: "within_policy" },
    });
    expect(result.desk.currentSlip).toMatchObject({ amountCents: 4200, status: "draft" });
  });

  it("restores the conversation with cards after a reload, each showing the expense as it is now", async () => {
    const b = await browser();
    await b.chat("$42 lunch", prepare(), say("Saved."));
    await b.chat("make it 48.50", prepare({ amount: 48.5 }), say("Updated."));

    const { messages, desk } = await b.reload();

    const cards = messages.flatMap((m) => (m.card?.kind === "expense" ? [m.card] : []));
    expect(cards.map((c) => [c.event, c.expense.status, c.expense.amountCents])).toEqual([
      ["drafted", "cancelled", 4200], // replaced: an old card can no longer be confirmed
      ["updated", "draft", 4850],
    ]);
    expect(cards[1]!.changes).toEqual([{ field: "amount", from: "$42.00", to: "$48.50" }]);
    expect(desk.currentSlip?.amountCents).toBe(4850);
  });

  it("reports a failed turn as a message with a retryable error", async () => {
    const b = await browser();

    const result = await b.chat("hi", new LlmError("rate_limited", { status: 429 }));

    expect(result.messages[1]).toMatchObject({ role: "assistant", error: { code: "provider_rate_limited", retryable: true } });
    expect(result.messages[1]!.text).toMatch(/try again/i);
  });

  it("marks a daily limit as not worth retrying", async () => {
    const limited = createApp({
      makeDeps: (e) => ({
        db: e.DB,
        llm: new FakeLlm(),
        now: () => NOW,
        config: { userDailyLimit: 0, appDailyLimit: 10, appPerMinuteLimit: 10, maxRounds: 5, requestTimeoutMs: 1000, receiptRequestTimeoutMs: 1000, deadlineMs: 2000, retryDelaysMs: [] },
      }),
      channels: { linkKey: () => "test-code-key", webUrl: () => null, telegramApi: () => null },
    });
    const session = await limited.request("/api/session", { method: "POST" }, env);
    const cookie = session.headers.get("set-cookie")!.split(";")[0]!;

    const res = await limited.request("/api/chat", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ text: "hi" }) }, env);

    expect(((await res.json()) as TurnResult).messages[1]!.error).toEqual({ code: "user_limit", retryable: false });
  });

  it("returns a notice, and stores nothing, for a message that is refused outright", async () => {
    const b = await browser();

    const result = await b.chat("   ");

    expect(result.messages).toEqual([]);
    expect(result.notice).toMatchObject({ code: "invalid_input" });
  });

  it.each([{}, { text: 5 }, "just a string"])("rejects a malformed body %j", async (body) => {
    const b = await browser();
    expect((await b.post("/api/chat", body)).status).toBe(400);
  });
});

describe("confirm and cancel", () => {
  it("submits the draft, attaches a 'submitted' card and updates the month's figures", async () => {
    const b = await browser();
    const drafted = await b.chat("$42 lunch", prepare(), say("Saved."));
    const id = drafted.desk.currentSlip!.id;

    const result = (await (await b.post(`/api/expenses/${id}/confirm`)).json()) as TurnResult;

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]!.card).toMatchObject({ kind: "expense", event: "submitted", expense: { id, status: "submitted" } });
    expect(result.desk.currentSlip).toBeNull();
    expect(result.desk.month.summary).toMatchObject({ totalCents: 4200, count: 1 });
    expect(result.desk.recent.map((e) => e.id)).toEqual([id]);
  });

  it("submits once when Confirm is pressed twice", async () => {
    const b = await browser();
    const id = (await b.chat("$42 lunch", prepare(), say("Saved."))).desk.currentSlip!.id;

    await Promise.all([b.post(`/api/expenses/${id}/confirm`), b.post(`/api/expenses/${id}/confirm`)]);

    expect((await b.reload()).desk.month.summary).toMatchObject({ totalCents: 4200, count: 1 });
  });

  it("refuses an outdated draft id and leaves the current draft alone", async () => {
    const b = await browser();
    const oldId = (await b.chat("$42 lunch", prepare(), say("Saved."))).desk.currentSlip!.id;
    await b.chat("make it 45", prepare({ amount: 45 }), say("Updated."));

    const result = (await (await b.post(`/api/expenses/${oldId}/confirm`)).json()) as TurnResult;

    expect(result.messages[0]!.text).toMatch(/no longer active/i);
    expect(result.desk.currentSlip?.amountCents).toBe(4500);
    expect(result.desk.month.summary.count).toBe(0);
  });

  it("discards the draft on cancel", async () => {
    const b = await browser();
    const id = (await b.chat("$42 lunch", prepare(), say("Saved."))).desk.currentSlip!.id;

    const result = (await (await b.post(`/api/expenses/${id}/cancel`)).json()) as TurnResult;

    expect(result.messages[0]!.card).toMatchObject({ event: "cancelled", expense: { status: "cancelled" } });
    expect(result.desk.currentSlip).toBeNull();
  });

  it.each(["abc", "0", "-3", "1.5"])("rejects the expense id %j", async (id) => {
    const b = await browser();
    expect((await b.post(`/api/expenses/${id}/confirm`)).status).toBe(400);
  });
});

describe("isolation between browsers", () => {
  it("shows a second browser none of the first one's conversation, draft or spending", async () => {
    const alice = await browser();
    const id = (await alice.chat("$42 lunch at Cafe Nero", prepare(), say("Saved."))).desk.currentSlip!.id;
    await alice.post(`/api/expenses/${id}/confirm`);

    const bob = await browser();
    const seen = await bob.reload();
    const listed = (await (await bob.send("/api/expenses")).json()) as { expenses: unknown[] };

    expect(JSON.stringify(seen)).not.toContain("Cafe Nero");
    expect(seen.desk.month.summary.totalCents).toBe(0);
    expect(listed.expenses).toEqual([]);
  });

  it("does not let one browser confirm or cancel another's draft", async () => {
    const alice = await browser();
    const id = (await alice.chat("$42 lunch", prepare(), say("Saved."))).desk.currentSlip!.id;
    const mallory = await browser();

    const confirm = (await (await mallory.post(`/api/expenses/${id}/confirm`)).json()) as TurnResult;
    await mallory.post(`/api/expenses/${id}/cancel`);

    expect(confirm.messages[0]!.text).toMatch(/couldn't find/i);
    expect(confirm.messages[0]!.card).toBeUndefined();
    expect((await alice.reload()).desk.currentSlip).toMatchObject({ id, status: "draft" });
  });
});

describe("receipt upload", () => {
  it("analyses an uploaded image and returns a receipt card with the draft", async () => {
    const b = await browser();
    llm = new FakeLlm(receiptJson());

    const res = await b.upload(new Blob([PNG], { type: "image/png" }), "team lunch");
    const result = (await res.json()) as TurnResult;

    expect(res.status).toBe(200);
    expect(result.messages[0]).toMatchObject({ role: "user", attachment: "receipt_photo", text: "team lunch" });
    expect(result.messages[1]!.card).toMatchObject({
      kind: "receipt",
      analysis: { status: "draft_created", fields: { merchant: "Cafe Aurora", amountCents: 4850 } },
      expense: { status: "draft", amountCents: 4850 },
    });
    expect(result.desk.currentSlip?.merchant).toBe("Cafe Aurora");
  });

  it("checks the file's real format, whatever type the browser claims", async () => {
    const b = await browser();
    llm = new FakeLlm();

    const res = await b.upload(new Blob(["total: 48.50"], { type: "image/png" }));
    const result = (await res.json()) as TurnResult;

    expect(result.notice).toMatchObject({ code: "invalid_image" });
    expect(result.messages).toEqual([]);
    expect(llm.requests).toHaveLength(0);
  });

  it("refuses an oversized upload before reading it", async () => {
    const b = await browser();
    const big = new Uint8Array(5 * 1024 * 1024);
    big.set(PNG);

    const res = await b.upload(new Blob([big], { type: "image/png" }));

    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ error: { code: "image_too_large" } });
  });

  it("rejects a request without an image", async () => {
    const b = await browser();
    const form = new FormData();
    form.set("caption", "nothing attached");
    expect((await b.send("/api/receipts", { method: "POST", body: form })).status).toBe(400);
  });

  it("puts a half-read receipt on the desk and drafts it when the currency is confirmed", async () => {
    const b = await browser();
    llm = new FakeLlm(receiptJson({ currency_evidence: "symbol" }));
    const read = (await (await b.upload(new Blob([PNG]))).json()) as TurnResult;
    expect(read.desk.pendingReceipt).toMatchObject({ status: "needs_details", missing: ["currency"], suggestedCurrency: "USD" });
    expect(read.desk.currentSlip).toBeNull();
    llm = new FakeLlm();

    const result = (await (await b.post("/api/receipts/pending/currency", { currency: "USD" })).json()) as TurnResult;

    expect(llm.requests).toHaveLength(0);
    expect(result.desk.pendingReceipt).toBeNull();
    expect(result.desk.currentSlip).toMatchObject({ amountCents: 4850, merchant: "Cafe Aurora" });
    expect(result.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
  });

  it("rejects a currency answer that is not a currency code", async () => {
    const b = await browser();
    expect((await b.post("/api/receipts/pending/currency", { currency: "dollars" })).status).toBe(400);
  });
});

describe("new conversation", () => {
  it("clears the conversation but keeps the draft and everything already submitted", async () => {
    const b = await browser();
    const firstId = (await b.chat("$42 lunch", prepare(), say("Saved."))).desk.currentSlip!.id;
    await b.post(`/api/expenses/${firstId}/confirm`);
    await b.chat("$20 taxi", prepare({ amount: 20, merchant: "Metro Cabs", category: "travel" }), say("Saved."));

    const res = await b.post("/api/conversation/reset");
    const fresh = (await res.json()) as Bootstrap;

    expect(res.status).toBe(200);
    expect(fresh.messages).toEqual([]);
    expect(fresh.desk.currentSlip).toMatchObject({ merchant: "Metro Cabs", status: "draft" });
    expect(fresh.desk.month.summary).toMatchObject({ totalCents: 4200, count: 1 });
    expect((await b.reload()).messages).toEqual([]);
  });

  it("starts the model with a clean history afterwards", async () => {
    const b = await browser();
    await b.chat("my project codename is Falcon", say("Noted."));
    await b.post("/api/conversation/reset");

    await b.chat("hello again", say("Hi."));

    expect(JSON.stringify(llm.requests[0]!.messages)).not.toContain("Falcon");
  });

  it("does not touch another browser's conversation", async () => {
    const alice = await browser();
    const bob = await browser();
    await bob.chat("bob's message", say("Hi Bob."));

    await alice.post("/api/conversation/reset");

    expect((await bob.reload()).messages).toHaveLength(2);
  });

  it("needs a session", async () => {
    const res = await app.request("/api/conversation/reset", { method: "POST" }, env);
    expect(res.status).toBe(401);
  });
});

describe("expenses and policy pages", () => {
  it("lists the user's submitted expenses and applies filters", async () => {
    const b = await browser();
    for (const overrides of [{ merchant: "Lunch Bar" }, { merchant: "Rail Co", category: "travel", amount: 80 }]) {
      const id = (await b.chat("expense", prepare(overrides), say("Saved."))).desk.currentSlip!.id;
      await b.post(`/api/expenses/${id}/confirm`);
    }

    const all = (await (await b.send("/api/expenses")).json()) as { expenses: { merchant: string }[] };
    const travel = (await (await b.send("/api/expenses?category=travel")).json()) as { expenses: { merchant: string }[] };

    expect(all.expenses.map((e) => e.merchant).sort()).toEqual(["Lunch Bar", "Rail Co"]);
    expect(travel.expenses.map((e) => e.merchant)).toEqual(["Rail Co"]);
  });

  it("rejects an invalid filter", async () => {
    const b = await browser();
    expect((await b.send("/api/expenses?status=approved")).status).toBe(400);
  });

  it("returns the policy as data", async () => {
    const b = await browser();

    const policy = (await (await b.send("/api/policy")).json()) as PolicyDto;

    expect(policy).toMatchObject({ currency: "USD", maxAgeDays: 90 });
    expect(policy.limits).toContainEqual({ category: "meals", limitCents: 7500 });
    expect(policy.rules.length).toBeGreaterThan(0);
  });

  it("checks an amount against policy without a model request", async () => {
    const b = await browser();
    llm = new FakeLlm();

    const check = (await (await b.send("/api/policy/check?category=meals&amount=120")).json()) as PolicyCheckDto;

    expect(check).toEqual({
      category: "meals",
      amountCents: 12000,
      limitCents: 7500,
      verdict: { outcome: "needs_review", notes: ["$120.00 is over the $75.00 per-expense limit for meals."] },
    });
    expect(llm.requests).toHaveLength(0);
  });

  it.each(["category=yachts&amount=10", "category=meals&amount=abc", "category=meals"])("rejects the policy check %j", async (query) => {
    const b = await browser();
    expect((await b.send(`/api/policy/check?${query}`)).status).toBe(400);
  });
});

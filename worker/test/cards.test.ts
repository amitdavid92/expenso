import { describe, expect, it } from "vitest";
import {
  type AssistantConfig,
  cancelDraftById,
  confirmDraftById,
  handleMessage,
} from "../src/assistant/assistant";
import { getPendingReceipt, handleReceipt, resolvePendingCurrency } from "../src/assistant/receipts";
import { executeTool } from "../src/assistant/tools";
import type { MessageMeta } from "../src/assistant/types";
import { LlmError } from "../src/llm/types";
import { appendMessage, listMessagesAfter, listRecentMessages } from "../src/services/conversations";
import { createDraft, getActiveDraft, getExpensesByIds } from "../src/services/expenses";
import { FakeLlm, call, say } from "./fake-llm";
import { db, newUser } from "./helpers";

const NOW = new Date("2026-11-24T10:00:00Z");
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

const lunchArgs = { amount: 42, currency: "USD", category: "meals", merchant: "Cafe Nero", date: "2026-11-23" };
const prepare = (overrides: Record<string, unknown> = {}) =>
  call({ name: "prepare_expense", args: { ...lunchArgs, ...overrides }, id: "c1" });

const receipt = (overrides: Record<string, unknown> = {}) =>
  say(
    JSON.stringify({
      image_kind: "receipt",
      merchant: "Cafe Aurora",
      total: 48.5,
      currency: "USD",
      currency_evidence: "code",
      date: "2026-11-23",
      category: "meals",
      description: "Lunch for two",
      ...overrides,
    }),
  );

function deps(llm: FakeLlm, config: Partial<AssistantConfig> = {}, now: Date = NOW) {
  return {
    db,
    llm,
    now: () => now,
    config: {
      userDailyLimit: 100,
      appDailyLimit: 100_000,
      appPerMinuteLimit: 100_000,
      maxRounds: 5,
      requestTimeoutMs: 1000,
      deadlineMs: 2000,
      retryDelaysMs: [0, 0],
      ...config,
    },
  };
}

/** The structured data stored with the user's latest messages, oldest first. */
async function metas(userId: number): Promise<(MessageMeta | null)[]> {
  return (await listRecentMessages(db, userId)).map((m) => m.meta as MessageMeta | null);
}

describe("message metadata", () => {
  it("stores and returns structured data next to the text", async () => {
    const user = await newUser();

    await appendMessage(db, user.id, "assistant", "hello", { lead: "hello", error: "timeout" });

    expect((await listRecentMessages(db, user.id))[0]).toMatchObject({
      content: "hello",
      meta: { lead: "hello", error: "timeout" },
    });
  });

  it("is null for a message stored without any", async () => {
    const user = await newUser();
    await appendMessage(db, user.id, "user", "hi");
    expect((await listRecentMessages(db, user.id))[0]!.meta).toBeNull();
  });

  it("lists only this user's messages after a given one", async () => {
    const alice = await newUser();
    const bob = await newUser();
    const first = await appendMessage(db, alice.id, "user", "one");
    await appendMessage(db, bob.id, "user", "bob's");
    await appendMessage(db, alice.id, "assistant", "two");

    const later = await listMessagesAfter(db, alice.id, first.id);

    expect(later.map((m) => m.content)).toEqual(["two"]);
  });
});

describe("cards from a chat turn", () => {
  it("attaches a 'drafted' card and keeps the model's sentence apart from the notice", async () => {
    const user = await newUser();

    await handleMessage(deps(new FakeLlm(prepare(), say("Saved that for you."))), { userId: user.id, text: "$42 lunch" });

    const draft = await getActiveDraft(db, user.id);
    const [, assistant] = await metas(user.id);
    expect(assistant).toEqual({
      lead: "Saved that for you.",
      card: { kind: "expense", event: "drafted", expenseId: draft!.id },
    });
    // The stored text is still complete on its own, for text-only channels.
    expect((await listRecentMessages(db, user.id))[1]!.content).toContain("Draft expense (not submitted yet):");
  });

  it("records exactly what changed when a draft is edited", async () => {
    const user = await newUser();
    await handleMessage(deps(new FakeLlm(prepare(), say("Saved."))), { userId: user.id, text: "$42 lunch" });

    await handleMessage(deps(new FakeLlm(prepare({ amount: 48.5, merchant: "Cafe Aurora" }), say("Updated."))), {
      userId: user.id,
      text: "make it 48.50 at Cafe Aurora",
    });

    const card = (await metas(user.id)).at(-1)!.card;
    expect(card).toMatchObject({
      kind: "expense",
      event: "updated",
      changes: [
        { field: "amount", from: "$42.00", to: "$48.50" },
        { field: "merchant", from: "Cafe Nero", to: "Cafe Aurora" },
      ],
    });
  });

  it("attaches a spending summary card when the model looked up totals", async () => {
    const user = await newUser();
    const llm = new FakeLlm(call({ name: "get_spending_summary", args: { from: "2026-11-01", to: "2026-11-30" } }), say("Nothing yet."));

    await handleMessage(deps(llm), { userId: user.id, text: "how much this month?" });

    expect((await metas(user.id)).at(-1)!.card).toEqual({
      kind: "summary",
      from: "2026-11-01",
      to: "2026-11-30",
      summary: { totalCents: 0, count: 0, needsReviewCount: 0, byCategory: [] },
    });
  });

  it("attaches the error code to a failed turn", async () => {
    const user = await newUser();

    await handleMessage(deps(new FakeLlm(new LlmError("rate_limited"))), { userId: user.id, text: "hi" });

    expect((await metas(user.id)).at(-1)).toEqual({ error: "provider_rate_limited" });
  });

  it("attaches 'submitted' and 'cancelled' cards for explicit actions", async () => {
    const user = await newUser();
    const first = await createDraft(db, user.id, { amountCents: 100, category: "other", merchant: "A", expenseDate: "2026-11-23" }, NOW);
    if (first.outcome !== "drafted") throw new Error("expected a draft");
    await cancelDraftById(deps(new FakeLlm()), { userId: user.id, expenseId: first.expense.id });
    const second = await createDraft(db, user.id, { amountCents: 200, category: "other", merchant: "B", expenseDate: "2026-11-23" }, NOW);
    if (second.outcome !== "drafted") throw new Error("expected a draft");
    await confirmDraftById(deps(new FakeLlm()), { userId: user.id, expenseId: second.expense.id });

    expect((await metas(user.id)).map((m) => m?.card)).toEqual([
      { kind: "expense", event: "cancelled", expenseId: first.expense.id },
      { kind: "expense", event: "submitted", expenseId: second.expense.id },
    ]);
  });

  it("attaches no card when a confirmation is refused", async () => {
    const user = await newUser();
    await confirmDraftById(deps(new FakeLlm()), { userId: user.id, expenseId: 999_999 });
    expect((await metas(user.id)).at(-1)?.card).toBeUndefined();
  });
});

describe("policy check tool", () => {
  it("returns a verdict and a card when given a category and an amount", async () => {
    const user = await newUser();

    const outcome = await executeTool({ db, userId: user.id, now: NOW }, { name: "get_policy", args: { category: "meals", amount: 120 } });

    expect(outcome.result).toMatchObject({ status: "ok", check: { amount: "$120.00", limit: "$75.00", verdict: "needs_review" } });
    expect(outcome.card).toEqual({
      kind: "policy_check",
      category: "meals",
      amountCents: 12000,
      limitCents: 7500,
      verdict: { outcome: "needs_review", notes: ["$120.00 is over the $75.00 per-expense limit for meals."] },
    });
  });

  it("gives no card for a plain policy lookup", async () => {
    const user = await newUser();
    const outcome = await executeTool({ db, userId: user.id, now: NOW }, { name: "get_policy", args: {} });
    expect(outcome.card).toBeUndefined();
  });

  it("rejects an amount without a category", async () => {
    const user = await newUser();
    const outcome = await executeTool({ db, userId: user.id, now: NOW }, { name: "get_policy", args: { amount: 50 } });
    expect(outcome.result.status).toBe("invalid_arguments");
  });
});

describe("placeholder merchants", () => {
  it.each(["Unknown", "n/a", "Restaurant", " store ", "MERCHANT", "?"])("refuses %j as a merchant name", async (merchant) => {
    const user = await newUser();

    const outcome = await executeTool({ db, userId: user.id, now: NOW }, { name: "prepare_expense", args: { ...lunchArgs, merchant } });

    expect(outcome.result.status).toBe("invalid_arguments");
    expect(await getActiveDraft(db, user.id)).toBeNull();
  });

  it("accepts a real name that merely contains such a word", async () => {
    const user = await newUser();
    const outcome = await executeTool({ db, userId: user.id, now: NOW }, { name: "prepare_expense", args: { ...lunchArgs, merchant: "The Corner Store" } });
    expect(outcome.result.status).toBe("draft_saved");
  });
});

describe("receipt cards and structured pending state", () => {
  it("marks the user's message as a photo and attaches the analysis with the draft", async () => {
    const user = await newUser();

    await handleReceipt(deps(new FakeLlm(receipt())), { userId: user.id, image: PNG });

    const draft = await getActiveDraft(db, user.id);
    const [userMeta, assistantMeta] = await metas(user.id);
    expect(userMeta).toEqual({ attachment: "receipt_photo" });
    expect(assistantMeta?.card).toMatchObject({ kind: "receipt", expenseId: draft!.id, analysis: { status: "draft_created" } });
    expect(await getPendingReceipt(db, user.id)).toBeNull();
  });

  it("keeps a partly read receipt as structured state", async () => {
    const user = await newUser();

    await handleReceipt(deps(new FakeLlm(receipt({ date: null }))), { userId: user.id, image: PNG });

    expect(await getPendingReceipt(db, user.id)).toMatchObject({
      status: "needs_details",
      missing: ["date"],
      fields: { merchant: "Cafe Aurora", amountCents: 4850, currency: "USD" },
    });
  });

  it("gives the chat model the pending receipt even when the conversation has moved far past it", async () => {
    const user = await newUser();
    await handleReceipt(deps(new FakeLlm(receipt({ date: null }))), { userId: user.id, image: PNG });
    for (let i = 0; i < 25; i++) await appendMessage(db, user.id, i % 2 ? "assistant" : "user", `filler ${i}`);
    const llm = new FakeLlm(say("What was the date?"));

    await handleMessage(deps(llm), { userId: user.id, text: "about that receipt" });

    expect(JSON.stringify(llm.requests[0]!.messages)).not.toContain("Cafe Aurora"); // out of the history window
    expect(llm.requests[0]!.system).toContain("Cafe Aurora");
    expect(llm.requests[0]!.system).toContain("$48.50");
    expect(llm.requests[0]!.system).toMatch(/still needed: date/i);
  });

  it("clears the pending receipt once a draft is created from it", async () => {
    const user = await newUser();
    await handleReceipt(deps(new FakeLlm(receipt({ date: null }))), { userId: user.id, image: PNG });

    await handleMessage(deps(new FakeLlm(prepare({ merchant: "Cafe Aurora", amount: 48.5 }), say("Done."))), { userId: user.id, text: "it was yesterday" });

    expect(await getPendingReceipt(db, user.id)).toBeNull();
    expect(await getActiveDraft(db, user.id)).not.toBeNull();
  });

  it("never shows one user's pending receipt to another", async () => {
    const alice = await newUser();
    const bob = await newUser();
    await handleReceipt(deps(new FakeLlm(receipt({ date: null }))), { userId: alice.id, image: PNG });
    const llm = new FakeLlm(say("Hi."));

    await handleMessage(deps(llm), { userId: bob.id, text: "hello" });

    expect(await getPendingReceipt(db, bob.id)).toBeNull();
    expect(llm.requests[0]!.system).not.toContain("Cafe Aurora");
  });

  it("discards the pending receipt when the user types cancel and there is no draft", async () => {
    const user = await newUser();
    await handleReceipt(deps(new FakeLlm(receipt({ date: null }))), { userId: user.id, image: PNG });

    const result = await handleMessage(deps(new FakeLlm()), { userId: user.id, text: "cancel" });

    expect(result.reply).toMatch(/receipt.*discarded/i);
    expect(await getPendingReceipt(db, user.id)).toBeNull();
  });
});

describe("currency is never assumed", () => {
  it("does not treat a bare $ sign as US dollars: it asks", async () => {
    const user = await newUser();

    const result = await handleReceipt(deps(new FakeLlm(receipt({ currency_evidence: "symbol" }))), { userId: user.id, image: PNG });

    expect(result.receipt).toMatchObject({
      status: "needs_details",
      missing: ["currency"],
      suggestedCurrency: "USD",
      fields: { currency: null, amountCents: 4850 },
    });
    expect(result.pendingExpense).toBeNull();
    expect(result.reply).toMatch(/currency/i);
    expect(result.reply).not.toContain("$48.50");
  });

  it.each([{ currency_evidence: "none" }, { currency_evidence: undefined }, { currency_evidence: "probably" }])(
    "does not accept a currency without a printed code (%j)",
    async (overrides) => {
      const user = await newUser();
      const result = await handleReceipt(deps(new FakeLlm(receipt(overrides))), { userId: user.id, image: PNG });
      expect(result.receipt?.missing).toEqual(["currency"]);
    },
  );

  it("drafts the receipt once the user confirms US dollars, without calling the model", async () => {
    const user = await newUser();
    await handleReceipt(deps(new FakeLlm(receipt({ currency_evidence: "symbol" }))), { userId: user.id, image: PNG });
    const llm = new FakeLlm();

    const result = await resolvePendingCurrency(deps(llm), { userId: user.id, currency: "USD" });

    expect(llm.requests).toHaveLength(0);
    expect(result.receipt?.status).toBe("draft_created");
    expect(result.pendingExpense).toMatchObject({ amountCents: 4850, merchant: "Cafe Aurora", status: "draft" });
    expect(await getPendingReceipt(db, user.id)).toBeNull();
  });

  it("still asks for other missing fields after the currency is confirmed", async () => {
    const user = await newUser();
    await handleReceipt(deps(new FakeLlm(receipt({ currency_evidence: "symbol", date: null }))), { userId: user.id, image: PNG });

    const result = await resolvePendingCurrency(deps(new FakeLlm()), { userId: user.id, currency: "USD" });

    expect(result.receipt).toMatchObject({ status: "needs_details", missing: ["date"], fields: { currency: "USD" } });
    expect(result.pendingExpense).toBeNull();
  });

  it("does not draft when the user says it is another currency", async () => {
    const user = await newUser();
    await handleReceipt(deps(new FakeLlm(receipt({ currency_evidence: "symbol" }))), { userId: user.id, image: PNG });

    const result = await resolvePendingCurrency(deps(new FakeLlm()), { userId: user.id, currency: "CAD" });

    expect(result.receipt?.status).toBe("unsupported_currency");
    expect(result.pendingExpense).toBeNull();
  });

  it("says so when there is no receipt waiting for a currency", async () => {
    const user = await newUser();
    const result = await resolvePendingCurrency(deps(new FakeLlm()), { userId: user.id, currency: "USD" });
    expect(result.reply).toMatch(/no receipt/i);
    expect(result.pendingExpense).toBeNull();
  });
});

describe("getExpensesByIds", () => {
  it("returns only the caller's expenses, whatever ids are asked for", async () => {
    const alice = await newUser();
    const bob = await newUser();
    const a = await createDraft(db, alice.id, { amountCents: 100, category: "other", merchant: "A", expenseDate: "2026-11-23" }, NOW);
    const b = await createDraft(db, bob.id, { amountCents: 200, category: "other", merchant: "B", expenseDate: "2026-11-23" }, NOW);
    if (a.outcome !== "drafted" || b.outcome !== "drafted") throw new Error("expected drafts");

    const found = await getExpensesByIds(db, alice.id, [a.expense.id, b.expense.id]);

    expect(found.map((e) => e.merchant)).toEqual(["A"]);
  });
});

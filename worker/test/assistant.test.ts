import { describe, expect, it } from "vitest";
import {
  type AssistantConfig,
  cancelDraftById,
  confirmDraftById,
  handleMessage,
} from "../src/assistant/assistant";
import { LlmError, type LlmMessage } from "../src/llm/types";
import { listRecentMessages } from "../src/services/conversations";
import { createDraft, getActiveDraft, listExpenses } from "../src/services/expenses";
import { FakeLlm, call, say } from "./fake-llm";
import { db, newUser } from "./helpers";

const NOW = new Date("2026-11-24T10:00:00Z");

const lunchArgs = { amount: 42, currency: "USD", category: "meals", merchant: "Cafe Nero", date: "2026-11-23" };
const prepare = (overrides: Record<string, unknown> = {}, id = "call_1") =>
  call({ name: "prepare_expense", args: { ...lunchArgs, ...overrides }, id });

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
      receiptRequestTimeoutMs: 1000,
      deadlineMs: 2000,
      retryDelaysMs: [0, 0],
      ...config,
    },
  };
}

async function countExpenses(userId: number, status: string) {
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM expenses WHERE user_id = ? AND status = ?")
    .bind(userId, status)
    .first<{ n: number }>();
  return row!.n;
}

async function quotaUsed(userId: number) {
  const row = await db
    .prepare("SELECT COALESCE(SUM(count), 0) AS n FROM usage_daily WHERE scope = ?")
    .bind(`user:${userId}`)
    .first<{ n: number }>();
  return row!.n;
}

const texts = (messages: LlmMessage[]) =>
  messages.map((m) => (m.role === "user" || m.role === "assistant" ? `${m.role}: ${m.text}` : m.role));

describe("conversation", () => {
  it("returns the model's answer and remembers both sides of the exchange", async () => {
    const user = await newUser();
    const llm = new FakeLlm(say("The meal limit is $75."));

    const result = await handleMessage(deps(llm), { userId: user.id, text: "What is the meal limit?" });

    expect(result).toEqual({ reply: "The meal limit is $75.", pendingExpense: null });
    expect((await listRecentMessages(db, user.id)).map((m) => [m.role, m.content])).toEqual([
      ["user", "What is the meal limit?"],
      ["assistant", "The meal limit is $75."],
    ]);
  });

  it("gives the model the earlier messages so a follow-up makes sense", async () => {
    const user = await newUser();
    await handleMessage(deps(new FakeLlm(say("Which restaurant was it?"))), {
      userId: user.id,
      text: "I spent $42 on lunch yesterday",
    });
    const llm = new FakeLlm(say("Thanks."));

    await handleMessage(deps(llm), { userId: user.id, text: "Cafe Nero" });

    expect(texts(llm.requests[0]!.messages)).toEqual([
      "user: I spent $42 on lunch yesterday",
      "assistant: Which restaurant was it?",
      "user: Cafe Nero",
    ]);
  });

  it("never shows the model another user's conversation", async () => {
    const alice = await newUser();
    const bob = await newUser("telegram");
    await handleMessage(deps(new FakeLlm(say("Noted."))), { userId: alice.id, text: "alice's private dinner" });
    const llm = new FakeLlm(say("Hi Bob."));

    await handleMessage(deps(llm), { userId: bob.id, text: "hello" });

    expect(JSON.stringify(llm.requests[0])).not.toContain("alice");
  });

  it("tells the model today's date and that there is no draft", async () => {
    const user = await newUser();
    const llm = new FakeLlm(say("Hello."));

    await handleMessage(deps(llm), { userId: user.id, text: "hi" });

    expect(llm.requests[0]!.system).toContain("2026-11-24");
    expect(llm.requests[0]!.system).toContain("no draft");
  });

  it("offers the model the tools but nothing that submits", async () => {
    const user = await newUser();
    const llm = new FakeLlm(say("Hello."));

    await handleMessage(deps(llm), { userId: user.id, text: "hi" });

    const names = llm.requests[0]!.tools!.map((t) => t.name);
    expect(names).toContain("prepare_expense");
    expect(names.join(" ")).not.toMatch(/confirm|submit/);
  });

  it("creates nothing when the model asks for missing details instead of calling a tool", async () => {
    const user = await newUser();
    const llm = new FakeLlm(say("How much was it, and where?"));

    const result = await handleMessage(deps(llm), { userId: user.id, text: "I had a business lunch" });

    expect(result.pendingExpense).toBeNull();
    expect(await countExpenses(user.id, "draft")).toBe(0);
    expect(llm.requests[0]!.system).toMatch(/never (guess|invent)/i);
  });

  it.each([
    ["an empty message", "   "],
    ["a message that is too long", "x".repeat(2001)],
  ])("answers %s without calling the model or storing it", async (_label, text) => {
    const user = await newUser();
    const llm = new FakeLlm();

    const result = await handleMessage(deps(llm), { userId: user.id, text });

    expect(result.error).toBe("invalid_input");
    expect(llm.requests).toHaveLength(0);
    expect(await listRecentMessages(db, user.id)).toEqual([]);
  });
});

describe("tools", () => {
  it("runs the requested tool, then lets the model answer", async () => {
    const user = await newUser();
    const llm = new FakeLlm(prepare(), say("I've prepared that for you."));

    const result = await handleMessage(deps(llm), { userId: user.id, text: "$42 lunch at Cafe Nero yesterday" });

    expect(llm.requests).toHaveLength(2);
    expect(result.pendingExpense).toMatchObject({ amountCents: 4200, merchant: "Cafe Nero", status: "draft" });
    expect(result.reply).toContain("I've prepared that for you.");
  });

  it("always tells the user, in the backend's own words, that a new draft is not submitted", async () => {
    const user = await newUser();
    const llm = new FakeLlm(prepare(), say("Done."));

    const result = await handleMessage(deps(llm), { userId: user.id, text: "$42 lunch at Cafe Nero yesterday" });

    expect(result.reply).toContain("Draft expense (not submitted yet):");
    expect(result.reply).toContain("$42.00 · meals · Cafe Nero · 2026-11-23");
    expect(result.reply).toContain('Type "confirm" to submit');
  });

  it("sends the model's tool request back exactly as received, signature included", async () => {
    const user = await newUser();
    const toolRequest = prepare();
    const llm = new FakeLlm(toolRequest, say("Done."));

    await handleMessage(deps(llm), { userId: user.id, text: "$42 lunch at Cafe Nero yesterday" });

    const [, modelTurn, toolResults] = llm.requests[1]!.messages.slice(-3);
    expect(modelTurn).toEqual({ role: "assistant_raw", raw: toolRequest.raw });
    expect((modelTurn as { raw: unknown }).raw).toBe(toolRequest.raw); // the same object, not a copy
    expect(JSON.stringify(modelTurn)).toContain("signature-for-prepare_expense");
    expect(toolResults).toMatchObject({
      role: "tool_results",
      results: [{ id: "call_1", name: "prepare_expense", result: { status: "draft_saved", submitted: false } }],
    });
  });

  it("keeps every step of a multi-step turn, in order", async () => {
    const user = await newUser();
    const first = call({ name: "get_policy", id: "a" });
    const second = prepare({}, "b");
    const llm = new FakeLlm(first, second, say("Done."));

    await handleMessage(deps(llm), { userId: user.id, text: "$42 lunch at Cafe Nero yesterday, is that ok?" });

    expect(llm.requests[2]!.messages.map((m) => m.role)).toEqual([
      "user",
      "assistant_raw",
      "tool_results",
      "assistant_raw",
      "tool_results",
    ]);
    expect((llm.requests[2]!.messages[1] as { raw: unknown }).raw).toBe(first.raw);
    expect((llm.requests[2]!.messages[3] as { raw: unknown }).raw).toBe(second.raw);
  });

  it("answers parallel tool calls together and in the order they were asked", async () => {
    const user = await newUser();
    const llm = new FakeLlm(
      call({ name: "get_policy", id: "a" }, { name: "get_spending_summary", id: "b" }),
      say("Here you go."),
    );

    await handleMessage(deps(llm), { userId: user.id, text: "policy and my total please" });

    const results = llm.requests[1]!.messages.at(-1) as Extract<LlmMessage, { role: "tool_results" }>;
    expect(results.results.map((r) => [r.id, r.name])).toEqual([
      ["a", "get_policy"],
      ["b", "get_spending_summary"],
    ]);
  });

  it("edits the draft on a follow-up: the old draft is replaced, not duplicated", async () => {
    const user = await newUser();
    await handleMessage(deps(new FakeLlm(prepare(), say("Saved."))), {
      userId: user.id,
      text: "$42 lunch at Cafe Nero yesterday",
    });
    const llm = new FakeLlm(prepare({ amount: 45 }), say("Updated."));

    const result = await handleMessage(deps(llm), { userId: user.id, text: "actually make it $45" });

    expect(llm.requests[0]!.system).toContain("$42.00 · meals · Cafe Nero · 2026-11-23");
    expect(result.pendingExpense?.amountCents).toBe(4500);
    expect(result.reply).toContain("$45.00");
    expect(await countExpenses(user.id, "draft")).toBe(1);
    expect(await countExpenses(user.id, "cancelled")).toBe(1);
    expect(await countExpenses(user.id, "submitted")).toBe(0);
  });

  it("tells the model about an unknown tool and carries on", async () => {
    const user = await newUser();
    const llm = new FakeLlm(call({ name: "confirm_expense", args: { id: 1 } }), say("Please type confirm."));

    const result = await handleMessage(deps(llm), { userId: user.id, text: "submit it" });

    const results = llm.requests[1]!.messages.at(-1) as Extract<LlmMessage, { role: "tool_results" }>;
    expect(results.results[0]!.result.status).toBe("unknown_tool");
    expect(result.reply).toBe("Please type confirm.");
    expect(result.error).toBeUndefined();
  });

  it("tells the model about malformed arguments, saves nothing, and carries on", async () => {
    const user = await newUser();
    const llm = new FakeLlm(prepare({ currency: "EUR", amount: "forty" }), say("I can only take USD amounts."));

    const result = await handleMessage(deps(llm), { userId: user.id, text: "40 euros for lunch" });

    const results = llm.requests[1]!.messages.at(-1) as Extract<LlmMessage, { role: "tool_results" }>;
    expect(results.results[0]!.result.status).toBe("invalid_arguments");
    expect(result.pendingExpense).toBeNull();
    expect(result.reply).toBe("I can only take USD amounts.");
  });

  it("only ever returns the calling user's data to the model", async () => {
    const alice = await newUser();
    const bob = await newUser();
    const bobsDraft = await createDraft(db, bob.id, { amountCents: 9900, category: "travel", merchant: "Bob Airways", expenseDate: "2026-11-20" }, NOW);
    if (bobsDraft.outcome === "drafted") await confirmDraftById(deps(new FakeLlm()), { userId: bob.id, expenseId: bobsDraft.expense.id });
    const llm = new FakeLlm(
      call({ name: "list_expenses", args: { user_id: bob.id } }, { name: "get_spending_summary", args: { userId: bob.id } }),
      say("You have no expenses."),
    );

    await handleMessage(deps(llm), { userId: alice.id, text: "show me everything" });

    expect(JSON.stringify(llm.requests[1])).not.toContain("Bob Airways");
    expect(JSON.stringify(llm.requests[1])).not.toContain("$99.00");
  });
});

describe("explicit confirmation", () => {
  async function withDraft() {
    const user = await newUser();
    await handleMessage(deps(new FakeLlm(prepare(), say("Saved."))), { userId: user.id, text: "$42 lunch at Cafe Nero yesterday" });
    return user;
  }

  it.each(["confirm", "Confirm", "  CONFIRM  ", "/confirm", "confirm.", "Confirm!"])(
    "submits the draft on %j without involving the model",
    async (text) => {
      const user = await withDraft();
      const llm = new FakeLlm();

      const result = await handleMessage(deps(llm), { userId: user.id, text });

      expect(llm.requests).toHaveLength(0);
      expect(result.reply).toContain("Submitted for processing:");
      expect(result.reply).toContain("$42.00 · meals · Cafe Nero · 2026-11-23");
      expect(result.pendingExpense).toBeNull();
      expect(await listExpenses(db, user.id)).toHaveLength(1);
    },
  );

  it("does not use any quota for a confirmation", async () => {
    const user = await withDraft();
    const before = await quotaUsed(user.id);

    await handleMessage(deps(new FakeLlm(), { userDailyLimit: 0 }), { userId: user.id, text: "confirm" });

    expect(await quotaUsed(user.id)).toBe(before);
    expect(await listExpenses(db, user.id)).toHaveLength(1);
  });

  it("says an over-limit expense was submitted but needs review, never that it was approved", async () => {
    const user = await newUser();
    await handleMessage(deps(new FakeLlm(prepare({ amount: 120 }), say("Saved."))), { userId: user.id, text: "$120 dinner" });

    const result = await handleMessage(deps(new FakeLlm()), { userId: user.id, text: "confirm" });

    expect(result.reply).toContain("Submitted for processing:");
    expect(result.reply).toContain("manual review");
    expect(result.reply).not.toMatch(/approved/i);
  });

  it("says there is nothing to confirm when there is no draft", async () => {
    const user = await newUser();
    const llm = new FakeLlm();

    const result = await handleMessage(deps(llm), { userId: user.id, text: "confirm" });

    expect(result.reply).toMatch(/no draft/i);
    expect(llm.requests).toHaveLength(0);
    expect(await countExpenses(user.id, "submitted")).toBe(0);
  });

  it("submits once when the user confirms twice", async () => {
    const user = await withDraft();
    await handleMessage(deps(new FakeLlm()), { userId: user.id, text: "confirm" });

    const again = await handleMessage(deps(new FakeLlm()), { userId: user.id, text: "confirm" });

    expect(again.reply).toMatch(/no draft/i);
    expect(await countExpenses(user.id, "submitted")).toBe(1);
  });

  it.each(["yes", "ok", "sure, confirm it please", "confirmed?"])(
    "does not treat %j as a confirmation: it goes to the model and nothing is submitted",
    async (text) => {
      const user = await withDraft();
      const llm = new FakeLlm(say('Please type "confirm" to submit it.'));

      await handleMessage(deps(llm), { userId: user.id, text });

      expect(llm.requests).toHaveLength(1);
      expect(await countExpenses(user.id, "submitted")).toBe(0);
      expect(await countExpenses(user.id, "draft")).toBe(1);
    },
  );

  it("refuses to submit a draft that policy no longer allows, and says why", async () => {
    const user = await newUser();
    await handleMessage(deps(new FakeLlm(prepare({ date: "2026-08-26" }), say("Saved."))), { userId: user.id, text: "old lunch" });

    const result = await handleMessage(deps(new FakeLlm(), {}, new Date("2026-12-01T10:00:00Z")), { userId: user.id, text: "confirm" });

    expect(result.reply).toContain("more than 90 days old");
    expect(result.reply).not.toContain("Submitted for processing");
    expect(await countExpenses(user.id, "submitted")).toBe(0);
  });

  it.each(["cancel", "/cancel", "Cancel."])("discards the draft on %j without involving the model", async (text) => {
    const user = await withDraft();
    const llm = new FakeLlm();

    const result = await handleMessage(deps(llm), { userId: user.id, text });

    expect(llm.requests).toHaveLength(0);
    expect(result.reply).toMatch(/discarded/i);
    expect(result.pendingExpense).toBeNull();
    expect(await countExpenses(user.id, "submitted")).toBe(0);
  });

  it("records the confirmation in the conversation so the model knows the outcome later", async () => {
    const user = await withDraft();
    await handleMessage(deps(new FakeLlm()), { userId: user.id, text: "confirm" });
    const llm = new FakeLlm(say("Yes, it went through."));

    await handleMessage(deps(llm), { userId: user.id, text: "did that go through?" });

    const history = texts(llm.requests[0]!.messages).join("\n");
    expect(history).toContain("user: confirm");
    expect(history).toContain("assistant: Submitted for processing:");
  });
});

describe("confirm and cancel by draft id (buttons)", () => {
  async function draftFor(userId: number) {
    const result = await createDraft(db, userId, { amountCents: 4200, category: "meals", merchant: "Cafe Nero", expenseDate: "2026-11-23" }, NOW);
    if (result.outcome !== "drafted") throw new Error("expected a draft");
    return result.expense;
  }

  it("submits that draft", async () => {
    const user = await newUser();
    const draft = await draftFor(user.id);

    const result = await confirmDraftById(deps(new FakeLlm()), { userId: user.id, expenseId: draft.id });

    expect(result.reply).toContain("Submitted for processing:");
    expect(result.pendingExpense).toBeNull();
  });

  it("answers a repeated press with the same expense and submits nothing new", async () => {
    const user = await newUser();
    const draft = await draftFor(user.id);
    await confirmDraftById(deps(new FakeLlm()), { userId: user.id, expenseId: draft.id });

    const again = await confirmDraftById(deps(new FakeLlm()), { userId: user.id, expenseId: draft.id });

    expect(again.reply).toMatch(/already submitted/i);
    expect(await countExpenses(user.id, "submitted")).toBe(1);
  });

  it("refuses an outdated button and points at the current draft", async () => {
    const user = await newUser();
    const stale = await draftFor(user.id);
    const current = await draftFor(user.id);

    const result = await confirmDraftById(deps(new FakeLlm()), { userId: user.id, expenseId: stale.id });

    expect(result.reply).toMatch(/no longer active/i);
    expect(result.pendingExpense?.id).toBe(current.id);
    expect(await countExpenses(user.id, "submitted")).toBe(0);
  });

  it("refuses another user's draft id without revealing it exists", async () => {
    const alice = await newUser();
    const mallory = await newUser();
    const draft = await draftFor(alice.id);

    const result = await confirmDraftById(deps(new FakeLlm()), { userId: mallory.id, expenseId: draft.id });

    expect(result.reply).toMatch(/couldn't find/i);
    expect((await getActiveDraft(db, alice.id))?.id).toBe(draft.id);
  });

  it("cancels that draft", async () => {
    const user = await newUser();
    const draft = await draftFor(user.id);

    const result = await cancelDraftById(deps(new FakeLlm()), { userId: user.id, expenseId: draft.id });

    expect(result.reply).toMatch(/discarded/i);
    expect(await getActiveDraft(db, user.id)).toBeNull();
  });

  it("says it is too late to cancel an expense that was already submitted", async () => {
    const user = await newUser();
    const draft = await draftFor(user.id);
    await confirmDraftById(deps(new FakeLlm()), { userId: user.id, expenseId: draft.id });

    const result = await cancelDraftById(deps(new FakeLlm()), { userId: user.id, expenseId: draft.id });

    expect(result.reply).toMatch(/already submitted/i);
    expect(await countExpenses(user.id, "submitted")).toBe(1);
  });

  it("never opens the conversation sent to the model with an assistant message", async () => {
    const user = await newUser();
    const draft = await draftFor(user.id);
    await confirmDraftById(deps(new FakeLlm()), { userId: user.id, expenseId: draft.id });
    const llm = new FakeLlm(say("Hello."));

    await handleMessage(deps(llm), { userId: user.id, text: "hi" });

    expect(llm.requests[0]!.messages[0]!.role).toBe("user");
  });
});

describe("the model cannot claim a submission", () => {
  it("replaces a false 'I submitted it' after saving a draft", async () => {
    const user = await newUser();
    const llm = new FakeLlm(prepare(), say("Great news! I've submitted your expense for $42."));

    const result = await handleMessage(deps(llm), { userId: user.id, text: "$42 lunch at Cafe Nero yesterday" });

    expect(result.reply).not.toMatch(/I've submitted/i);
    expect(result.reply).toContain("Draft expense (not submitted yet):");
    expect(await countExpenses(user.id, "submitted")).toBe(0);
  });

  it("replaces 'has been submitted' on a turn that only saved a draft", async () => {
    const user = await newUser();
    const llm = new FakeLlm(prepare(), say("Your expense has been submitted successfully."));

    const result = await handleMessage(deps(llm), { userId: user.id, text: "$42 lunch at Cafe Nero yesterday" });

    expect(result.reply).not.toMatch(/has been submitted/i);
    expect(result.reply).toContain("not submitted yet");
  });

  it("replaces a false claim made without any draft at all", async () => {
    const user = await newUser();
    const llm = new FakeLlm(say("All done, I have submitted it for you."));

    const result = await handleMessage(deps(llm), { userId: user.id, text: "yes go ahead" });

    expect(result.reply).not.toMatch(/I have submitted/i);
    expect(result.reply).toMatch(/can't submit/i);
  });

  it("stores the corrected text, not the false claim, in the conversation", async () => {
    const user = await newUser();
    const llm = new FakeLlm(say("I've submitted it."));

    await handleMessage(deps(llm), { userId: user.id, text: "submit" });

    const history = await listRecentMessages(db, user.id);
    expect(history.at(-1)!.content).not.toMatch(/I've submitted/i);
  });

  it("leaves honest statements about past submitted expenses alone", async () => {
    const user = await newUser();
    const honest = "You have 2 submitted expenses totalling $87.00. Both were submitted last week.";
    const llm = new FakeLlm(call({ name: "get_spending_summary" }), say(honest));

    const result = await handleMessage(deps(llm), { userId: user.id, text: "what have I submitted?" });

    expect(result.reply).toBe(honest);
  });
});

describe("quota", () => {
  it("uses one unit of quota for every request sent to the model", async () => {
    const user = await newUser();
    const llm = new FakeLlm(call({ name: "get_policy" }), prepare(), say("Done."));

    await handleMessage(deps(llm), { userId: user.id, text: "$42 lunch at Cafe Nero yesterday" });

    expect(llm.requests).toHaveLength(3);
    expect(await quotaUsed(user.id)).toBe(3);
  });

  it("does not call the model at all when the user's daily limit is used up", async () => {
    const user = await newUser();
    const llm = new FakeLlm();

    const result = await handleMessage(deps(llm, { userDailyLimit: 0 }), { userId: user.id, text: "hi" });

    expect(llm.requests).toHaveLength(0);
    expect(result.error).toBe("user_limit");
    expect(result.reply).toMatch(/daily limit/i);
  });

  it("does not call the model when the application's daily limit is used up, and says so differently", async () => {
    const user = await newUser();
    const llm = new FakeLlm();

    const result = await handleMessage(deps(llm, { appDailyLimit: 0 }), { userId: user.id, text: "hi" });

    expect(llm.requests).toHaveLength(0);
    expect(result.error).toBe("app_limit");
    expect(result.reply).toMatch(/free/i);
  });

  it("does not call the model when the application is over its per-minute rate, and asks to retry shortly", async () => {
    const user = await newUser();
    const llm = new FakeLlm();

    const result = await handleMessage(deps(llm, { appPerMinuteLimit: 0 }), { userId: user.id, text: "hi" });

    expect(llm.requests).toHaveLength(0);
    expect(result.error).toBe("busy");
    expect(result.reply).toMatch(/minute/i);
  });

  it("counts every model request against the per-minute rate, tool rounds included", async () => {
    const user = await newUser();
    const now = new Date("2033-05-01T09:00:00Z");
    const llm = new FakeLlm(call({ name: "get_policy" }), call({ name: "get_policy" }), say("never reached"));

    const result = await handleMessage(deps(llm, { appPerMinuteLimit: 2 }, now), { userId: user.id, text: "hi" });

    expect(llm.requests).toHaveLength(2);
    expect(result.error).toBe("busy");
  });

  it("stops mid-turn when the limit runs out, keeps the draft, and shows its true state", async () => {
    const user = await newUser();
    const llm = new FakeLlm(prepare());

    const result = await handleMessage(deps(llm, { userDailyLimit: 1 }), { userId: user.id, text: "$42 lunch at Cafe Nero yesterday" });

    expect(llm.requests).toHaveLength(1);
    expect(result.error).toBe("user_limit");
    expect(result.reply).toContain("Draft expense (not submitted yet):");
    expect(result.pendingExpense).toMatchObject({ amountCents: 4200 });
    expect(await countExpenses(user.id, "draft")).toBe(1);
  });

  it("still lets the user confirm after the limit is reached", async () => {
    const user = await newUser();
    await handleMessage(deps(new FakeLlm(prepare()), { userDailyLimit: 1 }), { userId: user.id, text: "$42 lunch at Cafe Nero yesterday" });

    const result = await handleMessage(deps(new FakeLlm(), { userDailyLimit: 1 }), { userId: user.id, text: "confirm" });

    expect(result.reply).toContain("Submitted for processing:");
  });
});

describe("failures", () => {
  it("gives a friendly message when the provider rate-limits us, without retrying", async () => {
    const user = await newUser();
    const llm = new FakeLlm(new LlmError("rate_limited", { status: 429 }));

    const result = await handleMessage(deps(llm), { userId: user.id, text: "hi" });

    expect(llm.requests).toHaveLength(1);
    expect(result.error).toBe("provider_rate_limited");
    expect(result.reply).toMatch(/try again/i);
    expect(result.reply).not.toMatch(/429|LlmError|rate_limited/);
  });

  it("retries after a network failure and then answers normally", async () => {
    const user = await newUser();
    const llm = new FakeLlm(new LlmError("network", { retryable: true }), say("Hello!"));

    const result = await handleMessage(deps(llm), { userId: user.id, text: "hi" });

    expect(result).toEqual({ reply: "Hello!", pendingExpense: null });
    expect(await quotaUsed(user.id)).toBe(2); // the retry is a real request too
  });

  it("rides out a short provider outage: two failures, then an answer", async () => {
    const user = await newUser();
    const busy = () => new LlmError("provider_error", { retryable: true, status: 503 });
    const llm = new FakeLlm(busy(), busy(), say("Hello!"));

    const result = await handleMessage(deps(llm), { userId: user.id, text: "hi" });

    expect(result).toEqual({ reply: "Hello!", pendingExpense: null });
    expect(llm.requests).toHaveLength(3);
  });

  it("gives up after two retries", async () => {
    const user = await newUser();
    const busy = () => new LlmError("provider_error", { retryable: true, status: 503 });
    const llm = new FakeLlm(busy(), busy(), busy(), say("too late"));

    const result = await handleMessage(deps(llm), { userId: user.id, text: "hi" });

    expect(llm.requests).toHaveLength(3);
    expect(result.error).toBe("unavailable");
  });

  it("waits before retrying, so a brief spike has time to pass", async () => {
    const user = await newUser();
    const llm = new FakeLlm(new LlmError("provider_error", { retryable: true, status: 503 }), say("Hello!"));

    const started = Date.now();
    await handleMessage(deps(llm, { retryDelaysMs: [80] }), { userId: user.id, text: "hi" });

    expect(Date.now() - started).toBeGreaterThanOrEqual(75);
  });

  it("does not wait for a retry it has no time left to make", async () => {
    const user = await newUser();
    const llm = new FakeLlm(new LlmError("provider_error", { retryable: true, status: 503 }), say("never"));

    const result = await handleMessage(deps(llm, { retryDelaysMs: [5000], deadlineMs: 300 }), { userId: user.id, text: "hi" });

    expect(llm.requests).toHaveLength(1);
    expect(result.error).toBe("unavailable");
  });

  it("does not repeat a tool's effect when the request after it is retried", async () => {
    const user = await newUser();
    const llm = new FakeLlm(prepare(), new LlmError("network", { retryable: true }), say("Saved."));

    const result = await handleMessage(deps(llm), { userId: user.id, text: "$42 lunch at Cafe Nero yesterday" });

    expect(result.error).toBeUndefined();
    expect(await countExpenses(user.id, "draft")).toBe(1);
    expect(await countExpenses(user.id, "cancelled")).toBe(0);
  });

  it.each<[string, Error, string]>([
    ["an invalid model response", new LlmError("invalid_response"), "unavailable"],
    ["a blocked prompt", new LlmError("blocked"), "unavailable"],
    ["a timeout", new LlmError("timeout"), "timeout"],
    ["an unexpected crash in the client", new TypeError("boom"), "unavailable"],
  ])("gives a friendly message for %s", async (_label, failure, code) => {
    const user = await newUser();
    const llm = new FakeLlm(failure);

    const result = await handleMessage(deps(llm), { userId: user.id, text: "hi" });

    expect(result.error).toBe(code);
    expect(result.reply.length).toBeGreaterThan(10);
    expect(result.reply).not.toMatch(/boom|LlmError|undefined/);
  });

  it("stops after five requests when the model keeps asking for tools", async () => {
    const user = await newUser();
    const llm = new FakeLlm(...Array.from({ length: 8 }, () => call({ name: "get_policy" })));

    const result = await handleMessage(deps(llm), { userId: user.id, text: "loop forever" });

    expect(llm.requests).toHaveLength(5);
    expect(result.error).toBe("too_many_steps");
  });

  it("retries a request that hung, and answers if the next attempt works", async () => {
    const user = await newUser();
    const llm = new FakeLlm(() => new Promise(() => {}), say("Hello!"));

    const result = await handleMessage(deps(llm, { requestTimeoutMs: 40 }), { userId: user.id, text: "hi" });

    expect(result).toEqual({ reply: "Hello!", pendingExpense: null });
  });

  it("cuts off a model request that hangs", async () => {
    const user = await newUser();
    const hang = () => new Promise<never>(() => {}); // never settles
    const llm = new FakeLlm(hang, hang, hang);

    const started = Date.now();
    const result = await handleMessage(deps(llm, { requestTimeoutMs: 40, deadlineMs: 5000 }), { userId: user.id, text: "hi" });

    expect(result.error).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("passes the model client a signal that aborts at the request timeout", async () => {
    const user = await newUser();
    let signal: AbortSignal | undefined;
    const llm = new FakeLlm((request) => {
      signal = request.signal;
      return new Promise(() => {});
    });

    await handleMessage(deps(llm, { requestTimeoutMs: 40 }), { userId: user.id, text: "hi" });

    expect(signal?.aborted).toBe(true);
  });

  it("stops starting new requests once the overall deadline has passed", async () => {
    const user = await newUser();
    const slowToolCall = async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
      return call({ name: "get_policy" });
    };
    const llm = new FakeLlm(slowToolCall, slowToolCall, slowToolCall, slowToolCall, slowToolCall);

    const result = await handleMessage(deps(llm, { requestTimeoutMs: 1000, deadlineMs: 100 }), { userId: user.id, text: "hi" });

    expect(result.error).toBe("timeout");
    expect(llm.requests.length).toBeLessThan(5);
  });

  it("keeps a draft saved before the failure and reports its true state", async () => {
    const user = await newUser();
    const llm = new FakeLlm(prepare(), new LlmError("rate_limited", { status: 429 }));

    const result = await handleMessage(deps(llm), { userId: user.id, text: "$42 lunch at Cafe Nero yesterday" });

    expect(result.error).toBe("provider_rate_limited");
    expect(result.reply).toContain("Draft expense (not submitted yet):");
    expect(await countExpenses(user.id, "draft")).toBe(1);
  });

  it("does not duplicate the expense when the user resends the message after a failure", async () => {
    const user = await newUser();
    const text = "$42 lunch at Cafe Nero yesterday";
    await handleMessage(deps(new FakeLlm(prepare(), new LlmError("timeout"))), { userId: user.id, text });

    await handleMessage(deps(new FakeLlm(prepare(), say("Saved."))), { userId: user.id, text });
    await handleMessage(deps(new FakeLlm()), { userId: user.id, text: "confirm" });

    expect(await countExpenses(user.id, "draft")).toBe(0);
    expect(await countExpenses(user.id, "submitted")).toBe(1);
  });

  it("recovers on the next message and keeps the failed exchange in the history", async () => {
    const user = await newUser();
    await handleMessage(deps(new FakeLlm(new LlmError("rate_limited"))), { userId: user.id, text: "first try" });
    const llm = new FakeLlm(say("Here now."));

    const result = await handleMessage(deps(llm), { userId: user.id, text: "second try" });

    expect(result).toEqual({ reply: "Here now.", pendingExpense: null });
    expect(llm.requests[0]!.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
  });
});

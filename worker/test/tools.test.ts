import { describe, expect, it } from "vitest";
import { TOOL_DECLARATIONS, executeTool } from "../src/assistant/tools";
import { confirmExpense, getActiveDraft, listExpenses } from "../src/services/expenses";
import { db, newUser } from "./helpers";

const NOW = new Date("2026-11-24T10:00:00Z");

const lunchArgs = {
  amount: 42,
  currency: "USD",
  category: "meals",
  merchant: "Cafe Nero",
  date: "2026-11-23",
};

function run(userId: number, name: string, args: unknown = {}) {
  return executeTool({ db, userId, now: NOW }, { name, args });
}

/** Puts a submitted expense in the database for the given user. */
async function submit(userId: number, overrides: Record<string, unknown> = {}) {
  await run(userId, "prepare_expense", { ...lunchArgs, ...overrides });
  const draft = await getActiveDraft(db, userId);
  await confirmExpense(db, userId, draft!.id, NOW);
}

describe("tool declarations", () => {
  it("offers exactly the five agreed tools", () => {
    expect(TOOL_DECLARATIONS.map((t) => t.name).sort()).toEqual([
      "cancel_draft",
      "get_policy",
      "get_spending_summary",
      "list_expenses",
      "prepare_expense",
    ]);
  });

  it("gives the model no way to submit, confirm or approve an expense", () => {
    for (const tool of TOOL_DECLARATIONS) {
      expect(tool.name).not.toMatch(/confirm|submit|approve/i);
    }
  });

  it("never asks the model for a user id", () => {
    expect(JSON.stringify(TOOL_DECLARATIONS)).not.toMatch(/user_?id/i);
  });
});

describe("prepare_expense", () => {
  it("saves a draft for the calling user and says it is not submitted", async () => {
    const user = await newUser();

    const { result, draftChanged } = await run(user.id, "prepare_expense", lunchArgs);

    expect(result).toMatchObject({
      status: "draft_saved",
      submitted: false,
      draft: { amount: "$42.00", category: "meals", merchant: "Cafe Nero", date: "2026-11-23", policy: "within_policy" },
    });
    expect(draftChanged).toBe(true);
    expect(await getActiveDraft(db, user.id)).toMatchObject({ amountCents: 4200, status: "draft" });
    expect(await listExpenses(db, user.id)).toEqual([]);
  });

  it("converts a decimal dollar amount to exact cents", async () => {
    const user = await newUser();
    await run(user.id, "prepare_expense", { ...lunchArgs, amount: 19.99 });
    expect((await getActiveDraft(db, user.id))?.amountCents).toBe(1999);
  });

  it("reports an over-limit expense as needing review", async () => {
    const user = await newUser();

    const { result } = await run(user.id, "prepare_expense", { ...lunchArgs, amount: 120 });

    expect(result).toMatchObject({
      status: "draft_saved",
      draft: { policy: "needs_review", policy_notes: "$120.00 is over the $75.00 per-expense limit for meals." },
    });
  });

  it("reports a policy block and saves nothing", async () => {
    const user = await newUser();

    const { result, draftChanged } = await run(user.id, "prepare_expense", { ...lunchArgs, date: "2026-12-25" });

    expect(result).toMatchObject({ status: "blocked_by_policy", reasons: ["The expense date is in the future."] });
    expect(draftChanged).toBeFalsy();
    expect(await getActiveDraft(db, user.id)).toBeNull();
  });

  it("ignores a user id supplied by the model and always uses the authenticated user", async () => {
    const alice = await newUser();
    const bob = await newUser();

    await run(alice.id, "prepare_expense", { ...lunchArgs, user_id: bob.id, userId: bob.id });

    expect(await getActiveDraft(db, alice.id)).not.toBeNull();
    expect(await getActiveDraft(db, bob.id)).toBeNull();
  });

  it.each<[string, Record<string, unknown>]>([
    ["a currency other than USD", { currency: "EUR" }],
    ["a missing currency", { currency: undefined }],
    ["a non-text currency", { currency: 840 }],
    ["a missing amount", { amount: undefined }],
    ["a negative amount", { amount: -5 }],
    ["an amount with fractions of a cent", { amount: 10.005 }],
    ["an amount that is not a number", { amount: "lots" }],
    ["an unknown category", { category: "yachts" }],
    ["a missing merchant", { merchant: undefined }],
    ["a merchant that is not text", { merchant: { name: "x" } }],
    ["a malformed date", { date: "yesterday" }],
    ["a description that is not text", { description: 5 }],
  ])("rejects %s and saves nothing", async (_label, overrides) => {
    const user = await newUser();

    const { result, draftChanged } = await run(user.id, "prepare_expense", { ...lunchArgs, ...overrides });

    expect(result.status).toBe("invalid_arguments");
    expect((result.issues as string[]).length).toBeGreaterThan(0);
    expect(draftChanged).toBeFalsy();
    expect(await getActiveDraft(db, user.id)).toBeNull();
  });

  it("names the unsupported currency so the model can explain it", async () => {
    const user = await newUser();
    const { result } = await run(user.id, "prepare_expense", { ...lunchArgs, currency: "EUR" });
    expect((result.issues as string[]).join(" ")).toContain("Only USD");
  });

  it.each([null, "amount=42", 42, [lunchArgs]])("rejects arguments that are not an object: %j", async (args) => {
    const user = await newUser();
    const { result } = await run(user.id, "prepare_expense", args);
    expect(result.status).toBe("invalid_arguments");
  });
});

describe("cancel_draft", () => {
  it("cancels the calling user's draft", async () => {
    const user = await newUser();
    await run(user.id, "prepare_expense", lunchArgs);

    const { result, draftChanged } = await run(user.id, "cancel_draft");

    expect(result.status).toBe("draft_cancelled");
    expect(draftChanged).toBe(true);
    expect(await getActiveDraft(db, user.id)).toBeNull();
  });

  it("says so when there is no draft", async () => {
    const user = await newUser();
    expect((await run(user.id, "cancel_draft")).result.status).toBe("no_active_draft");
  });

  it("cannot touch another user's draft", async () => {
    const alice = await newUser();
    const bob = await newUser();
    await run(alice.id, "prepare_expense", lunchArgs);

    await run(bob.id, "cancel_draft");

    expect(await getActiveDraft(db, alice.id)).not.toBeNull();
  });
});

describe("list_expenses", () => {
  it("lists only the calling user's submitted expenses", async () => {
    const alice = await newUser();
    const bob = await newUser();
    await submit(alice.id, { merchant: "Alice's hotel", category: "lodging", amount: 200 });
    await submit(bob.id, { merchant: "Bob's taxi" });

    const { result } = await run(alice.id, "list_expenses");

    expect(result).toMatchObject({
      status: "ok",
      count: 1,
      expenses: [{ amount: "$200.00", merchant: "Alice's hotel", status: "submitted" }],
    });
    expect(JSON.stringify(result)).not.toContain("Bob");
  });

  it("applies the filters", async () => {
    const user = await newUser();
    await submit(user.id, { merchant: "Lunch", category: "meals", date: "2026-11-10" });
    await submit(user.id, { merchant: "Train", category: "travel", date: "2026-11-12" });

    const { result } = await run(user.id, "list_expenses", { category: "travel", from: "2026-11-01", to: "2026-11-30" });

    expect((result.expenses as { merchant: string }[]).map((e) => e.merchant)).toEqual(["Train"]);
  });

  it.each<[string, Record<string, unknown>]>([
    ["an unknown status", { status: "approved" }],
    ["an unknown category", { category: "yachts" }],
    ["a malformed date", { from: "last week" }],
    ["a non-numeric limit", { limit: "all" }],
    ["a limit that is too large", { limit: 5000 }],
  ])("rejects %s", async (_label, args) => {
    const user = await newUser();
    expect((await run(user.id, "list_expenses", args)).result.status).toBe("invalid_arguments");
  });
});

describe("get_spending_summary", () => {
  it("totals only the calling user's submitted expenses, formatted as dollars", async () => {
    const alice = await newUser();
    const bob = await newUser();
    await submit(alice.id, { amount: 42 });
    await submit(alice.id, { amount: 120 });
    await submit(bob.id, { amount: 70 });

    const { result } = await run(alice.id, "get_spending_summary");

    expect(result).toMatchObject({
      status: "ok",
      total: "$162.00",
      count: 2,
      needs_review_count: 1,
      by_category: [{ category: "meals", total: "$162.00", count: 2 }],
    });
  });

  it("rejects a malformed date range", async () => {
    const user = await newUser();
    expect((await run(user.id, "get_spending_summary", { from: "2026-11-30", to: "2026-11-01" })).result.status).toBe(
      "invalid_arguments",
    );
  });
});

describe("get_policy", () => {
  it("returns every limit, the currency and the age rule", async () => {
    const user = await newUser();

    const { result } = await run(user.id, "get_policy");

    expect(result).toMatchObject({
      status: "ok",
      currency: "USD",
      max_expense_age_days: 90,
      per_expense_limits: { meals: "$75.00", travel: "$500.00", lodging: "$300.00" },
    });
  });

  it("returns a single category when asked", async () => {
    const user = await newUser();
    const { result } = await run(user.id, "get_policy", { category: "software" });
    expect(result.per_expense_limits).toEqual({ software: "$100.00" });
  });

  it("rejects an unknown category", async () => {
    const user = await newUser();
    expect((await run(user.id, "get_policy", { category: "yachts" })).result.status).toBe("invalid_arguments");
  });
});

describe("unknown tools", () => {
  it.each(["confirm_expense", "submit_expense", "delete_everything", ""])(
    "refuses to run %j and changes nothing",
    async (name) => {
      const user = await newUser();
      await run(user.id, "prepare_expense", lunchArgs);

      const { result } = await run(user.id, name, { id: 1 });

      expect(result.status).toBe("unknown_tool");
      expect(await getActiveDraft(db, user.id)).toMatchObject({ status: "draft" });
    },
  );
});

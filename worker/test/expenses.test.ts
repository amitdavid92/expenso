import { describe, expect, it } from "vitest";
import { ValidationError } from "../src/lib/errors";
import {
  type DraftInput,
  MAX_AMOUNT_CENTS,
  cancelDraft,
  confirmExpense,
  createDraft,
  getActiveDraft,
  getSpendingSummary,
  listExpenses,
} from "../src/services/expenses";
import { db, newUser } from "./helpers";

const NOW = new Date("2026-11-24T10:00:00Z");

const lunch: DraftInput = {
  amountCents: 4200,
  category: "meals",
  merchant: "Cafe Nero",
  expenseDate: "2026-11-20",
};

/** Creates a draft and fails the test if policy blocked it. */
async function draft(userId: number, overrides: Partial<DraftInput> = {}) {
  const result = await createDraft(db, userId, { ...lunch, ...overrides }, NOW);
  if (result.outcome !== "drafted") throw new Error(`expected a draft, got ${result.outcome}`);
  return result.expense;
}

async function submitted(userId: number, overrides: Partial<DraftInput> = {}) {
  const expense = await draft(userId, overrides);
  await confirmExpense(db, userId, expense.id, NOW);
  return expense;
}

async function countRows(userId: number, status: string) {
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM expenses WHERE user_id = ? AND status = ?")
    .bind(userId, status)
    .first<{ n: number }>();
  return row!.n;
}

describe("createDraft", () => {
  it("stores a draft that is not yet submitted", async () => {
    const user = await newUser();

    const result = await createDraft(db, user.id, { ...lunch, description: " Client lunch " }, NOW);

    expect(result).toEqual({
      outcome: "drafted",
      expense: expect.objectContaining({
        amountCents: 4200,
        category: "meals",
        merchant: "Cafe Nero",
        expenseDate: "2026-11-20",
        description: "Client lunch",
        status: "draft",
        policyResult: "within_policy",
        policyNotes: null,
        submittedAt: null,
      }),
    });
  });

  it("records the policy verdict on a draft that is over the limit", async () => {
    const user = await newUser();

    const expense = await draft(user.id, { amountCents: 7501 });

    expect(expense.policyResult).toBe("needs_review");
    expect(expense.policyNotes).toBe("$75.01 is over the $75.00 per-expense limit for meals.");
  });

  it("does not create a draft when policy blocks the expense", async () => {
    const user = await newUser();

    const result = await createDraft(db, user.id, { ...lunch, expenseDate: "2026-11-25" }, NOW);

    expect(result).toEqual({ outcome: "blocked", reasons: ["The expense date is in the future."] });
    expect(await getActiveDraft(db, user.id)).toBeNull();
  });

  it("keeps the existing draft when a replacement is blocked by policy", async () => {
    const user = await newUser();
    const original = await draft(user.id);

    await createDraft(db, user.id, { ...lunch, expenseDate: "2020-01-01" }, NOW);

    expect((await getActiveDraft(db, user.id))?.id).toBe(original.id);
  });

  it("replaces the previous draft so only one is active", async () => {
    const user = await newUser();
    const first = await draft(user.id);

    const second = await draft(user.id, { amountCents: 4500 });

    expect(second.id).not.toBe(first.id);
    expect((await getActiveDraft(db, user.id))?.id).toBe(second.id);
    expect(await countRows(user.id, "draft")).toBe(1);
    expect(await countRows(user.id, "cancelled")).toBe(1);
  });

  it("leaves other users' drafts alone when replacing", async () => {
    const alice = await newUser();
    const bob = await newUser();
    const bobsDraft = await draft(bob.id);

    await draft(alice.id);
    await draft(alice.id, { amountCents: 100 });

    expect((await getActiveDraft(db, bob.id))?.id).toBe(bobsDraft.id);
  });

  it("ends with exactly one draft when several are created concurrently", async () => {
    const user = await newUser();

    const results = await Promise.all(
      [100, 200, 300, 400, 500].map((amountCents) =>
        createDraft(db, user.id, { ...lunch, amountCents }, NOW),
      ),
    );

    expect(results.every((r) => r.outcome === "drafted")).toBe(true);
    expect(await countRows(user.id, "draft")).toBe(1);
    expect(await countRows(user.id, "cancelled")).toBe(4);
  });

  it("accepts USD given explicitly, in any letter case", async () => {
    const user = await newUser();
    const result = await createDraft(db, user.id, { ...lunch, currency: "usd" }, NOW);
    expect(result.outcome).toBe("drafted");
  });

  it("accepts the largest allowed amount", async () => {
    const user = await newUser();
    const expense = await draft(user.id, { amountCents: MAX_AMOUNT_CENTS });
    expect(expense.amountCents).toBe(MAX_AMOUNT_CENTS);
  });

  it.each<[string, Record<string, unknown>]>([
    ["a zero amount", { amountCents: 0 }],
    ["a negative amount", { amountCents: -100 }],
    ["a fractional number of cents", { amountCents: 42.5 }],
    ["an amount over the maximum", { amountCents: MAX_AMOUNT_CENTS + 1 }],
    ["a non-numeric amount", { amountCents: "4200" }],
    ["an unknown category", { category: "yachts" }],
    ["an empty merchant", { merchant: "   " }],
    ["an oversized merchant", { merchant: "x".repeat(101) }],
    ["a malformed date", { expenseDate: "20/11/2026" }],
    ["a date that does not exist", { expenseDate: "2026-02-30" }],
    ["an oversized description", { description: "x".repeat(501) }],
    ["a currency other than USD", { currency: "EUR" }],
  ])("rejects %s without touching the database", async (_label, overrides) => {
    const user = await newUser();
    const original = await draft(user.id);

    await expect(
      createDraft(db, user.id, { ...lunch, ...overrides } as DraftInput, NOW),
    ).rejects.toThrow(ValidationError);

    expect((await getActiveDraft(db, user.id))?.id).toBe(original.id);
  });

  it("reports every invalid field at once", async () => {
    const user = await newUser();

    const error = await createDraft(
      db,
      user.id,
      { ...lunch, amountCents: -1, category: "yachts" as never, merchant: "" },
      NOW,
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).issues).toHaveLength(3);
  });
});

describe("confirmExpense", () => {
  it("submits the draft and records when", async () => {
    const user = await newUser();
    const expense = await draft(user.id);

    const result = await confirmExpense(db, user.id, expense.id, NOW);

    expect(result).toEqual({
      outcome: "submitted",
      expense: expect.objectContaining({
        id: expense.id,
        status: "submitted",
        submittedAt: "2026-11-24T10:00:00.000Z",
      }),
    });
    expect(await getActiveDraft(db, user.id)).toBeNull();
  });

  it("submits an over-limit expense but keeps it marked for review", async () => {
    const user = await newUser();
    const expense = await draft(user.id, { amountCents: 20000 });

    const result = await confirmExpense(db, user.id, expense.id, NOW);

    expect(result).toMatchObject({
      outcome: "submitted",
      expense: { status: "submitted", policyResult: "needs_review" },
    });
  });

  it("is idempotent: confirming twice returns the same expense and creates nothing new", async () => {
    const user = await newUser();
    const expense = await draft(user.id);
    await confirmExpense(db, user.id, expense.id, NOW);

    const again = await confirmExpense(db, user.id, expense.id, new Date("2026-11-24T11:00:00Z"));

    expect(again).toMatchObject({
      outcome: "already_submitted",
      expense: { id: expense.id, submittedAt: "2026-11-24T10:00:00.000Z" },
    });
    expect(await countRows(user.id, "submitted")).toBe(1);
  });

  it("submits exactly once when confirmed many times concurrently", async () => {
    const user = await newUser();
    const expense = await draft(user.id);

    const results = await Promise.all(
      Array.from({ length: 10 }, () => confirmExpense(db, user.id, expense.id, NOW)),
    );

    expect(results.filter((r) => r.outcome === "submitted")).toHaveLength(1);
    expect(results.filter((r) => r.outcome === "already_submitted")).toHaveLength(9);
    expect(await countRows(user.id, "submitted")).toBe(1);
  });

  it("refuses a draft that was replaced by a newer one", async () => {
    const user = await newUser();
    const stale = await draft(user.id);
    const current = await draft(user.id, { amountCents: 4500 });

    const result = await confirmExpense(db, user.id, stale.id, NOW);

    expect(result).toEqual({ outcome: "not_active" });
    expect(await countRows(user.id, "submitted")).toBe(0);
    expect((await getActiveDraft(db, user.id))?.id).toBe(current.id);
  });

  it("refuses a draft that was cancelled", async () => {
    const user = await newUser();
    const expense = await draft(user.id);
    await cancelDraft(db, user.id, expense.id);

    expect(await confirmExpense(db, user.id, expense.id, NOW)).toEqual({ outcome: "not_active" });
  });

  it("refuses another user's draft and leaves it untouched", async () => {
    const alice = await newUser();
    const mallory = await newUser();
    const expense = await draft(alice.id);

    const result = await confirmExpense(db, mallory.id, expense.id, NOW);

    expect(result).toEqual({ outcome: "not_found" });
    expect((await getActiveDraft(db, alice.id))?.status).toBe("draft");
  });

  it("gives the same answer for another user's submitted expense as for a missing one", async () => {
    const alice = await newUser();
    const mallory = await newUser();
    const expense = await submitted(alice.id);

    expect(await confirmExpense(db, mallory.id, expense.id, NOW)).toEqual({ outcome: "not_found" });
  });

  it("reports an id that does not exist as not found", async () => {
    const user = await newUser();
    expect(await confirmExpense(db, user.id, 999_999_999, NOW)).toEqual({ outcome: "not_found" });
  });

  it.each([0, -1, 1.5, "7", null])("rejects an invalid expense id %j", async (id) => {
    const user = await newUser();
    await expect(confirmExpense(db, user.id, id as never, NOW)).rejects.toThrow(ValidationError);
  });

  describe("policy is checked again at confirmation", () => {
    // Drafted on 2026-11-24 with a date exactly 90 days old: allowed that day.
    const agedDraft = { expenseDate: "2026-08-26" };

    it("submits a draft that is still within the age limit on the day it is confirmed", async () => {
      const user = await newUser();
      const expense = await draft(user.id, agedDraft);

      const result = await confirmExpense(db, user.id, expense.id, new Date("2026-11-24T23:59:59Z"));

      expect(result.outcome).toBe("submitted");
    });

    it("refuses a draft that became too old while it waited, and does not submit it", async () => {
      const user = await newUser();
      const expense = await draft(user.id, agedDraft);

      const result = await confirmExpense(db, user.id, expense.id, new Date("2026-11-25T00:00:00Z"));

      expect(result).toEqual({
        outcome: "blocked",
        reasons: ["The expense is more than 90 days old and can no longer be submitted."],
      });
      expect(await countRows(user.id, "submitted")).toBe(0);
    });

    it("leaves a blocked draft in place so it can still be cancelled or replaced", async () => {
      const user = await newUser();
      const expense = await draft(user.id, agedDraft);
      const later = new Date("2026-12-01T00:00:00Z");
      await confirmExpense(db, user.id, expense.id, later);

      expect((await getActiveDraft(db, user.id))?.id).toBe(expense.id);
      expect((await cancelDraft(db, user.id, expense.id)).outcome).toBe("cancelled");
    });

    it("blocks every attempt when a too-old draft is confirmed concurrently", async () => {
      const user = await newUser();
      const expense = await draft(user.id, agedDraft);
      const later = new Date("2026-12-01T00:00:00Z");

      const results = await Promise.all(
        Array.from({ length: 5 }, () => confirmExpense(db, user.id, expense.id, later)),
      );

      expect(results.every((r) => r.outcome === "blocked")).toBe(true);
      expect(await countRows(user.id, "submitted")).toBe(0);
    });

    it("still reports an already submitted expense as submitted after it has aged past the limit", async () => {
      const user = await newUser();
      const expense = await draft(user.id, agedDraft);
      await confirmExpense(db, user.id, expense.id, NOW);

      const again = await confirmExpense(db, user.id, expense.id, new Date("2027-06-01T00:00:00Z"));

      expect(again.outcome).toBe("already_submitted");
    });

    it("does not reveal policy details about another user's aged draft", async () => {
      const alice = await newUser();
      const mallory = await newUser();
      const expense = await draft(alice.id, agedDraft);

      const result = await confirmExpense(db, mallory.id, expense.id, new Date("2026-12-01T00:00:00Z"));

      expect(result).toEqual({ outcome: "not_found" });
    });
  });

  it("never both submits the old draft and loses the new one when confirm races a replacement", async () => {
    const user = await newUser();
    const old = await draft(user.id);

    const [confirmation, replacement] = await Promise.all([
      confirmExpense(db, user.id, old.id, NOW),
      createDraft(db, user.id, { ...lunch, amountCents: 9900 }, NOW),
    ]);

    expect(replacement.outcome).toBe("drafted");
    expect(["submitted", "not_active"]).toContain(confirmation.outcome);
    expect(await countRows(user.id, "draft")).toBe(1);
    expect(await countRows(user.id, "submitted")).toBe(confirmation.outcome === "submitted" ? 1 : 0);
  });
});

describe("cancelDraft", () => {
  it("cancels the draft", async () => {
    const user = await newUser();
    const expense = await draft(user.id);

    const result = await cancelDraft(db, user.id, expense.id);

    expect(result).toMatchObject({ outcome: "cancelled", expense: { status: "cancelled" } });
    expect(await getActiveDraft(db, user.id)).toBeNull();
  });

  it("is idempotent: cancelling twice reports it was already cancelled", async () => {
    const user = await newUser();
    const expense = await draft(user.id);
    await cancelDraft(db, user.id, expense.id);

    expect(await cancelDraft(db, user.id, expense.id)).toMatchObject({ outcome: "already_cancelled" });
  });

  it("does not cancel an expense that was already submitted", async () => {
    const user = await newUser();
    const expense = await submitted(user.id);

    const result = await cancelDraft(db, user.id, expense.id);

    expect(result).toMatchObject({ outcome: "already_submitted", expense: { status: "submitted" } });
    expect(await countRows(user.id, "submitted")).toBe(1);
  });

  it("refuses another user's draft and leaves it untouched", async () => {
    const alice = await newUser();
    const mallory = await newUser();
    const expense = await draft(alice.id);

    expect(await cancelDraft(db, mallory.id, expense.id)).toEqual({ outcome: "not_found" });
    expect((await getActiveDraft(db, alice.id))?.id).toBe(expense.id);
  });

  it("lets exactly one of a concurrent confirm and cancel win", async () => {
    const user = await newUser();
    const expense = await draft(user.id);

    const [confirmation, cancellation] = await Promise.all([
      confirmExpense(db, user.id, expense.id, NOW),
      cancelDraft(db, user.id, expense.id),
    ]);

    const confirmed = confirmation.outcome === "submitted";
    const cancelled = cancellation.outcome === "cancelled";
    expect(confirmed !== cancelled).toBe(true);
    expect((await countRows(user.id, "submitted")) + (await countRows(user.id, "cancelled"))).toBe(1);
  });
});

describe("listExpenses", () => {
  it("lists submitted expenses newest first and leaves out drafts and cancelled ones", async () => {
    const user = await newUser();
    await submitted(user.id, { merchant: "Older", expenseDate: "2026-11-01" });
    await submitted(user.id, { merchant: "Newer", expenseDate: "2026-11-15" });
    const cancelled = await draft(user.id, { merchant: "Cancelled" });
    await cancelDraft(db, user.id, cancelled.id);
    await draft(user.id, { merchant: "Still a draft" });

    const expenses = await listExpenses(db, user.id);

    expect(expenses.map((e) => e.merchant)).toEqual(["Newer", "Older"]);
  });

  it("never returns another user's expenses", async () => {
    const alice = await newUser();
    const bob = await newUser();
    await submitted(alice.id, { merchant: "Alice's hotel" });
    await submitted(bob.id, { merchant: "Bob's taxi" });

    expect((await listExpenses(db, alice.id)).map((e) => e.merchant)).toEqual(["Alice's hotel"]);
  });

  it("filters by category and by an inclusive date range", async () => {
    const user = await newUser();
    await submitted(user.id, { merchant: "A", category: "meals", expenseDate: "2026-10-31" });
    await submitted(user.id, { merchant: "B", category: "meals", expenseDate: "2026-11-01" });
    await submitted(user.id, { merchant: "C", category: "travel", expenseDate: "2026-11-10" });
    await submitted(user.id, { merchant: "D", category: "meals", expenseDate: "2026-11-20" });
    await submitted(user.id, { merchant: "E", category: "meals", expenseDate: "2026-11-21" });

    const expenses = await listExpenses(db, user.id, {
      category: "meals",
      from: "2026-11-01",
      to: "2026-11-20",
    });

    expect(expenses.map((e) => e.merchant)).toEqual(["D", "B"]);
  });

  it("can list drafts when asked", async () => {
    const user = await newUser();
    await submitted(user.id, { merchant: "Done" });
    await draft(user.id, { merchant: "Pending" });

    const expenses = await listExpenses(db, user.id, { status: "draft" });

    expect(expenses.map((e) => e.merchant)).toEqual(["Pending"]);
  });

  it("respects the limit", async () => {
    const user = await newUser();
    for (const day of ["01", "02", "03"]) {
      await submitted(user.id, { expenseDate: `2026-11-${day}` });
    }

    expect(await listExpenses(db, user.id, { limit: 2 })).toHaveLength(2);
  });

  it.each<[string, Record<string, unknown>]>([
    ["an unknown status", { status: "approved" }],
    ["an unknown category", { category: "yachts" }],
    ["a malformed from date", { from: "November" }],
    ["a malformed to date", { to: "2026-13-01" }],
    ["a range that ends before it starts", { from: "2026-11-20", to: "2026-11-01" }],
    ["a zero limit", { limit: 0 }],
    ["a limit over the maximum", { limit: 51 }],
  ])("rejects %s", async (_label, filters) => {
    const user = await newUser();
    await expect(listExpenses(db, user.id, filters as never)).rejects.toThrow(ValidationError);
  });
});

describe("getSpendingSummary", () => {
  it("totals submitted expenses by category in whole cents", async () => {
    const user = await newUser();
    await submitted(user.id, { category: "meals", amountCents: 1999 });
    await submitted(user.id, { category: "meals", amountCents: 2001 });
    await submitted(user.id, { category: "travel", amountCents: 60000 }); // over limit
    await draft(user.id, { category: "meals", amountCents: 5000 }); // not submitted

    const summary = await getSpendingSummary(db, user.id);

    expect(summary).toEqual({
      totalCents: 64000,
      count: 3,
      needsReviewCount: 1,
      byCategory: [
        { category: "travel", totalCents: 60000, count: 1 },
        { category: "meals", totalCents: 4000, count: 2 },
      ],
    });
  });

  it("returns zeros for a user with no submitted expenses", async () => {
    const user = await newUser();
    expect(await getSpendingSummary(db, user.id)).toEqual({
      totalCents: 0,
      count: 0,
      needsReviewCount: 0,
      byCategory: [],
    });
  });

  it("never includes another user's spending", async () => {
    const alice = await newUser();
    const bob = await newUser();
    await submitted(alice.id, { amountCents: 1000 });
    await submitted(bob.id, { amountCents: 7000 });

    expect((await getSpendingSummary(db, alice.id)).totalCents).toBe(1000);
  });

  it("limits the summary to an inclusive date range", async () => {
    const user = await newUser();
    await submitted(user.id, { amountCents: 100, expenseDate: "2026-10-31" });
    await submitted(user.id, { amountCents: 200, expenseDate: "2026-11-01" });
    await submitted(user.id, { amountCents: 400, expenseDate: "2026-11-20" });

    const summary = await getSpendingSummary(db, user.id, { from: "2026-11-01", to: "2026-11-20" });

    expect(summary.totalCents).toBe(600);
  });

  it("rejects a malformed date range", async () => {
    const user = await newUser();
    await expect(getSpendingSummary(db, user.id, { from: "yesterday" })).rejects.toThrow(
      ValidationError,
    );
  });
});

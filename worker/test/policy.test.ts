import { describe, expect, it } from "vitest";
import { CATEGORIES, POLICY, evaluateExpense } from "../src/services/policy";

const TODAY = "2026-11-24";

describe("evaluateExpense", () => {
  it("accepts an expense within the category limit", () => {
    expect(
      evaluateExpense({ amountCents: 4200, category: "meals", expenseDate: "2026-11-20" }, TODAY),
    ).toEqual({ outcome: "within_policy" });
  });

  it.each(CATEGORIES)("treats an amount exactly at the %s limit as within policy", (category) => {
    const limit = POLICY.limitsCents[category];
    expect(evaluateExpense({ amountCents: limit, category, expenseDate: TODAY }, TODAY)).toEqual({
      outcome: "within_policy",
    });
  });

  it.each(CATEGORIES)("flags one cent over the %s limit for review", (category) => {
    const limit = POLICY.limitsCents[category];
    const verdict = evaluateExpense({ amountCents: limit + 1, category, expenseDate: TODAY }, TODAY);
    expect(verdict.outcome).toBe("needs_review");
  });

  it("explains which limit was exceeded", () => {
    const verdict = evaluateExpense(
      { amountCents: 12000, category: "meals", expenseDate: TODAY },
      TODAY,
    );
    expect(verdict).toEqual({
      outcome: "needs_review",
      notes: ["$120.00 is over the $75.00 per-expense limit for meals."],
    });
  });

  it("accepts an expense dated today", () => {
    expect(
      evaluateExpense({ amountCents: 100, category: "other", expenseDate: TODAY }, TODAY).outcome,
    ).toBe("within_policy");
  });

  it("blocks an expense dated tomorrow", () => {
    expect(
      evaluateExpense({ amountCents: 100, category: "other", expenseDate: "2026-11-25" }, TODAY),
    ).toEqual({ outcome: "blocked", reasons: ["The expense date is in the future."] });
  });

  it("accepts an expense exactly 90 days old", () => {
    // 2026-11-24 minus 90 days
    expect(
      evaluateExpense({ amountCents: 100, category: "other", expenseDate: "2026-08-26" }, TODAY)
        .outcome,
    ).toBe("within_policy");
  });

  it("blocks an expense 91 days old", () => {
    expect(
      evaluateExpense({ amountCents: 100, category: "other", expenseDate: "2026-08-25" }, TODAY),
    ).toEqual({
      outcome: "blocked",
      reasons: ["The expense is more than 90 days old and can no longer be submitted."],
    });
  });

  it("blocks rather than flags when an expense is both too old and over the limit", () => {
    expect(
      evaluateExpense({ amountCents: 999999, category: "meals", expenseDate: "2025-01-01" }, TODAY)
        .outcome,
    ).toBe("blocked");
  });
});

describe("POLICY", () => {
  it("defines a positive whole-cent limit for every category", () => {
    for (const category of CATEGORIES) {
      expect(Number.isInteger(POLICY.limitsCents[category])).toBe(true);
      expect(POLICY.limitsCents[category]).toBeGreaterThan(0);
    }
  });
});

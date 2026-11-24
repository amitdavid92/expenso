import { daysBetween } from "../lib/dates";
import { formatCents } from "../lib/money";

/**
 * Fictional company expense policy. Pure functions, no database, no model:
 * the same input always gives the same verdict.
 */

export const CATEGORIES = ["meals", "travel", "lodging", "software", "office", "other"] as const;
export type Category = (typeof CATEGORIES)[number];

export const POLICY = {
  currency: "USD",
  /** Expenses older than this cannot be submitted. */
  maxAgeDays: 90,
  /** Per-expense limits. Going over is allowed but sends the expense to manual review. */
  limitsCents: {
    meals: 75_00,
    travel: 500_00,
    lodging: 300_00,
    software: 100_00,
    office: 150_00,
    other: 50_00,
  } satisfies Record<Category, number>,
} as const;

export type PolicyVerdict =
  | { outcome: "within_policy" }
  /** May be submitted, but a human has to look at it. */
  | { outcome: "needs_review"; notes: string[] }
  /** May not be submitted at all. */
  | { outcome: "blocked"; reasons: string[] };

export interface PolicyInput {
  amountCents: number;
  category: Category;
  /** YYYY-MM-DD */
  expenseDate: string;
}

/**
 * @param today the current UTC day (YYYY-MM-DD); passed in so the rules are testable.
 */
export function evaluateExpense(input: PolicyInput, today: string): PolicyVerdict {
  const ageDays = daysBetween(input.expenseDate, today);

  if (ageDays < 0) {
    return { outcome: "blocked", reasons: ["The expense date is in the future."] };
  }
  if (ageDays > POLICY.maxAgeDays) {
    return {
      outcome: "blocked",
      reasons: [
        `The expense is more than ${POLICY.maxAgeDays} days old and can no longer be submitted.`,
      ],
    };
  }

  const limit = POLICY.limitsCents[input.category];
  if (input.amountCents > limit) {
    return {
      outcome: "needs_review",
      notes: [
        `${formatCents(input.amountCents)} is over the ${formatCents(limit)} per-expense limit for ${input.category}.`,
      ],
    };
  }

  return { outcome: "within_policy" };
}

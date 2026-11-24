import { formatCents } from "../lib/money";
import type { Expense } from "../services/expenses";

/**
 * Text about expenses that is written by code, not by the model. Anything the
 * user is told about whether an expense was saved or submitted comes from here.
 */

export function describeExpense(expense: Expense): string {
  const parts = [formatCents(expense.amountCents), expense.category, expense.merchant, expense.expenseDate];
  return parts.join(" · ") + (expense.description ? ` · ${expense.description}` : "");
}

function describePolicy(expense: Expense): string {
  return expense.policyResult === "within_policy"
    ? "Within policy."
    : `Over a policy limit, so it will need manual review. ${expense.policyNotes ?? ""}`.trim();
}

/** Shown whenever a draft was created or changed. */
export function draftNotice(expense: Expense): string {
  return [
    "Draft expense (not submitted yet):",
    describeExpense(expense),
    describePolicy(expense),
    'Type "confirm" to submit it or "cancel" to discard it.',
  ].join("\n");
}

export function submittedNotice(expense: Expense): string {
  return ["Submitted for processing:", describeExpense(expense), describePolicy(expense)].join("\n");
}

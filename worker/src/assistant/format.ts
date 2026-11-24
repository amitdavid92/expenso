import type { ReceiptFieldsDto } from "../../../shared/contract";
import { formatCents } from "../lib/money";
import type { Expense } from "../services/expenses";
import { POLICY } from "../services/policy";

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

/** A receipt amount in words. Only a confirmed USD amount is written with a dollar sign. */
export function formatReceiptAmount(fields: ReceiptFieldsDto): string | null {
  if (fields.amountCents === null) return null;
  if (fields.currency === POLICY.currency) return formatCents(fields.amountCents);
  const plain = (fields.amountCents / 100).toFixed(2);
  return fields.currency ? `${plain} ${fields.currency}` : `${plain} (currency not confirmed)`;
}

/** One line listing what was read from a receipt. */
export function describeReceiptFields(fields: ReceiptFieldsDto): string {
  const amount = formatReceiptAmount(fields);
  const parts = [
    fields.merchant && `merchant: ${fields.merchant}`,
    amount && `amount: ${amount}`,
    fields.expenseDate && `date: ${fields.expenseDate}`,
    fields.category && `category: ${fields.category}`,
    fields.description && `note: ${fields.description}`,
  ].filter(Boolean);
  return parts.join("; ");
}

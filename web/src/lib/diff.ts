import type { ExpenseDto } from "../../../shared/contract";

export type SlipField = "amount" | "merchant" | "date" | "category" | "description";

/**
 * Which fields differ between the slip that was on the desk and the one that
 * replaced it. Used only for the brief "this just changed" highlight; the
 * permanent record of a change comes from the server.
 */
export function changedFields(before: ExpenseDto | null, after: ExpenseDto | null): SlipField[] {
  if (!before || !after || before.id === after.id) return [];
  const changed: SlipField[] = [];
  if (before.amountCents !== after.amountCents) changed.push("amount");
  if (before.merchant !== after.merchant) changed.push("merchant");
  if (before.expenseDate !== after.expenseDate) changed.push("date");
  if (before.category !== after.category) changed.push("category");
  if ((before.description ?? "") !== (after.description ?? "")) changed.push("description");
  return changed;
}

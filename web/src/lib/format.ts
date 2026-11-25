import type { Category, FieldChange, ReceiptAnalysisDto, ReceiptFieldsDto } from "../../../shared/contract";

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

/** Integer cents → "$48.50". The backend never sends a float. */
export function money(cents: number): string {
  return usd.format(cents / 100);
}

const dayFormat = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});
const weekdayFormat = new Intl.DateTimeFormat("en-GB", { weekday: "short", timeZone: "UTC" });
const monthFormat = new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });

function parseDay(iso: string): Date {
  return new Date(`${iso.slice(0, 10)}T00:00:00Z`);
}

/** "2026-11-23" → "23 Nov 2026". */
export function day(iso: string): string {
  return dayFormat.format(parseDay(iso));
}

/** "2026-11-23" → "Mon 23 Nov 2026". */
export function dayWithWeekday(iso: string): string {
  const date = parseDay(iso);
  return `${weekdayFormat.format(date)} ${dayFormat.format(date)}`;
}

/** "2026-11-01" → "November 2026". */
export function month(iso: string): string {
  return monthFormat.format(parseDay(iso));
}

export const CATEGORY_LABEL: Record<Category, string> = {
  meals: "Meals",
  travel: "Travel",
  lodging: "Lodging",
  software: "Software",
  office: "Office",
  other: "Other",
};

const FIELD_LABEL: Record<FieldChange["field"], string> = {
  amount: "Amount",
  category: "Category",
  merchant: "Merchant",
  date: "Date",
  description: "Note",
};

/** "Amount changed $42.00 → $48.50", in the words a person would use. */
export function describeChange(change: FieldChange): string {
  const label = FIELD_LABEL[change.field];
  const show = (value: string) => {
    if (change.field === "date") return day(value);
    if (change.field === "category") return CATEGORY_LABEL[value as Category] ?? value;
    return value;
  };
  if (change.field === "description" && change.from !== "" && change.to !== "") return "Note updated";
  if (change.from === "") return `${label} added: ${show(change.to)}`;
  if (change.to === "") return `${label} removed`;
  return `${label} changed ${show(change.from)} → ${show(change.to)}`;
}

/** A receipt amount: only a confirmed USD amount is written with a dollar sign. */
export function receiptAmount(fields: ReceiptFieldsDto): string | null {
  if (fields.amountCents === null) return null;
  if (fields.currency === "USD") return money(fields.amountCents);
  const plain = (fields.amountCents / 100).toFixed(2);
  return fields.currency ? `${plain} ${fields.currency}` : plain;
}

/**
 * A waiting receipt in two short lines: what state it is in, and what would
 * move it on. A receipt blocked by policy is not "missing details".
 */
export function describePendingReceipt(analysis: ReceiptAnalysisDto): { title: string; detail: string; blocked: boolean } {
  if (analysis.status === "blocked_by_policy") {
    return { title: "Receipt can't be submitted", detail: analysis.reasons.join(" ") || "Policy does not allow it.", blocked: true };
  }
  if (analysis.status === "unsupported_currency") {
    return {
      title: `Receipt is in ${analysis.fields.currency ?? "another currency"}`,
      detail: "Only USD is supported. Give the amount in USD.",
      blocked: false,
    };
  }
  if (analysis.missing.length === 1 && analysis.missing[0] === "currency" && analysis.suggestedCurrency) {
    return { title: "Receipt needs one answer", detail: `Is the total in ${analysis.suggestedCurrency}?`, blocked: false };
  }
  return {
    title: "Receipt needs details",
    detail: analysis.missing.length > 0 ? `Still needed: ${analysis.missing.join(", ")}` : "Open it to continue.",
    blocked: false,
  };
}

export function elapsedLabel(seconds: number): string {
  return seconds < 1 ? "" : `${Math.floor(seconds)}s`;
}

import { ValidationError } from "./errors";

/**
 * Money is stored and compared as whole cents. This is the only place where a
 * decimal dollar amount (from a user or the model) is turned into cents.
 */
export function toCents(amount: unknown): number {
  let cents: number;

  if (typeof amount === "string") {
    const text = amount.trim();
    if (!/^\d+(\.\d{1,2})?$/.test(text)) {
      throw new ValidationError("Amount must be a number of dollars with at most two decimals.");
    }
    const [dollars = "0", fraction = ""] = text.split(".");
    cents = Number(dollars) * 100 + Number(fraction.padEnd(2, "0"));
  } else if (typeof amount === "number" && Number.isFinite(amount)) {
    const scaled = amount * 100;
    cents = Math.round(scaled);
    // 42.5 * 100 is exact enough; 10.005 * 100 is not a whole number of cents.
    if (Math.abs(scaled - cents) > 1e-6) {
      throw new ValidationError("Amount cannot have fractions of a cent.");
    }
  } else {
    throw new ValidationError("Amount must be a number of dollars.");
  }

  if (!Number.isSafeInteger(cents) || cents <= 0) {
    throw new ValidationError("Amount must be greater than zero.");
  }
  return cents;
}

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

export function formatCents(cents: number): string {
  return usd.format(cents / 100);
}

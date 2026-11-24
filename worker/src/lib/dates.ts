const DAY_MS = 24 * 60 * 60 * 1000;

/** True for a real calendar date written as YYYY-MM-DD (so not 2026-02-30). */
export function isIsoDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/** The UTC calendar day of an instant, as YYYY-MM-DD. */
export function utcDay(instant: Date): string {
  return instant.toISOString().slice(0, 10);
}

/** Whole days from `from` to `to` (both YYYY-MM-DD); negative if `to` is earlier. */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
}

const pacificDay = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Los_Angeles",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/**
 * The calendar day in US Pacific time, as YYYY-MM-DD (daylight saving included).
 * Gemini's daily quota resets at midnight Pacific, so usage is counted per Pacific day.
 */
export function quotaDay(instant: Date): string {
  return pacificDay.format(instant);
}

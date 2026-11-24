import type { Category, SpendingSummaryDto } from "../../../../shared/contract";
import { CATEGORY_LABEL, money } from "../../lib/format";

/**
 * Six steps of the neutral ink, darkest for the largest share (indigo is kept for the stamp and the primary action). The legend beside
 * the bar names every segment, so the shades never carry meaning on their own.
 */
const SHADES = [
  "oklch(0.3 0.03 268)",
  "oklch(0.43 0.028 268)",
  "oklch(0.56 0.024 268)",
  "oklch(0.68 0.02 268)",
  "oklch(0.78 0.015 268)",
  "oklch(0.86 0.01 268)",
];

/**
 * Submitted spending, split by category: one stacked bar and its legend.
 * Every number is the backend's; nothing is totalled in the browser.
 */
export function SpendingSummary({ summary }: { summary: SpendingSummaryDto }) {
  if (summary.count === 0) return null;
  const shade = (i: number) => SHADES[Math.min(i, SHADES.length - 1)]!;

  return (
    <div>
      <div
        className="flex h-2.5 gap-px overflow-hidden rounded-full"
        role="img"
        aria-label={summary.byCategory
          .map((c) => `${CATEGORY_LABEL[c.category]} ${money(c.totalCents)}`)
          .join(", ")}
      >
        {summary.byCategory.map((c, i) => (
          <div
            key={c.category}
            className="h-full min-w-1 transition-[flex-grow] duration-500 ease-(--ease-out-expo)"
            style={{ flexGrow: c.totalCents, background: shade(i) }}
          />
        ))}
      </div>

      <ul className="mt-3 space-y-1.5">
        {summary.byCategory.map((c, i) => (
          <li key={c.category} className="flex items-baseline gap-2 text-sm">
            <span className="size-2 shrink-0 translate-y-px rounded-full" style={{ background: shade(i) }} aria-hidden="true" />
            <span className="text-ink">{CATEGORY_LABEL[c.category as Category]}</span>
            <span className="text-ink-3">
              {c.count} {c.count === 1 ? "expense" : "expenses"}
            </span>
            <span className="figure ml-auto text-ink">{money(c.totalCents)}</span>
          </li>
        ))}
      </ul>

      {summary.needsReviewCount > 0 && (
        <p className="mt-3 text-sm text-review">
          {summary.needsReviewCount} of {summary.count} {summary.needsReviewCount === 1 ? "is" : "are"} waiting for
          manual review.
        </p>
      )}
    </div>
  );
}

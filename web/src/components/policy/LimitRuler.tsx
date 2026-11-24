import type { Category } from "../../../../shared/contract";
import { CATEGORY_LABEL, money } from "../../lib/format";

/**
 * Policy as a ruler rather than a badge: the amount drawn against its
 * category's per-expense limit, so "how close am I?" is visible at a glance.
 *
 * Under the limit, the limit sits at 80% of the track and the bar grows towards
 * it. Over the limit, the track stretches to the amount and the part past the
 * limit mark is hatched. Quarter marks below the track make it a scale, and the
 * limit mark is labelled. The numbers and the sentence carry the same
 * information for anyone who cannot see the bar.
 */
export function LimitRuler({
  category,
  amountCents,
  limitCents,
}: {
  category: Category;
  amountCents: number;
  limitCents: number;
}) {
  const over = amountCents > limitCents;
  // Where the limit mark sits. Never left of 30%, so a huge overage keeps the bar readable.
  const limitAt = over ? Math.max(30, (limitCents / amountCents) * 100) : 80;
  const filled = over ? limitAt : (amountCents / limitCents) * limitAt;
  const quarters = [0.25, 0.5, 0.75].map((share) => share * limitAt);

  const sentence = over
    ? `${money(amountCents)} is ${money(amountCents - limitCents)} over the ${money(limitCents)} limit for ${CATEGORY_LABEL[category]}.`
    : `${money(amountCents)} of the ${money(limitCents)} limit for ${CATEGORY_LABEL[category]}.`;

  return (
    <div role="img" aria-label={sentence}>
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <span className="text-ink-2">{CATEGORY_LABEL[category]}</span>
        <span className="figure text-ink">
          {money(amountCents)}
          {over && <span className="text-review"> · {money(amountCents - limitCents)} over</span>}
        </span>
      </div>

      <div className="relative mt-2 h-2.5">
        <div className="absolute inset-0 overflow-hidden rounded-full bg-desk-deep">
          <div
            className="absolute inset-y-0 left-0 bg-ink/75 transition-[width] duration-300 ease-(--ease-out-expo)"
            style={{ width: `${filled}%` }}
          />
          {over && (
            <div
              className="hatch absolute inset-y-0 right-0 transition-[left] duration-300 ease-(--ease-out-expo)"
              style={{ left: `${limitAt}%` }}
            />
          )}
        </div>
        {/* The limit mark stands a little taller than the track. */}
        <div
          className="absolute -top-1 -bottom-1 w-0.5 rounded-full bg-ink transition-[left] duration-300 ease-(--ease-out-expo)"
          style={{ left: `calc(${limitAt}% - 1px)` }}
        />
      </div>

      {/* The scale: quarter marks up to the limit, and the limit's own value at its mark. */}
      <div className="relative mt-1 h-7" aria-hidden="true">
        {quarters.map((at) => (
          <span key={at} className="absolute top-0 h-1 w-px bg-line-strong" style={{ left: `${at}%` }} />
        ))}
        <span
          className="absolute top-2 -translate-x-1/2 text-2xs whitespace-nowrap text-ink-2 transition-[left] duration-300 ease-(--ease-out-expo)"
          style={{ left: `${limitAt}%` }}
        >
          limit <span className="figure">{money(limitCents)}</span>
        </span>
      </div>
    </div>
  );
}

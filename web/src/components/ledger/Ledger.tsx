import type { DeskState, ExpenseDto } from "../../../../shared/contract";
import { CATEGORY_LABEL, day, money, month } from "../../lib/format";
import { useCountUp } from "../../state/hooks";
import { SpendingSummary } from "./SpendingSummary";

export function LedgerRow({ expense, fresh }: { expense: ExpenseDto; fresh: boolean }) {
  return (
    <li className={`flex items-baseline gap-3 py-2.5 ${fresh ? "animate-changed" : ""}`}>
      <span className="w-14 shrink-0 text-sm text-ink-3 tabular-nums">{day(expense.expenseDate).replace(/ \d{4}$/, "")}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm text-ink">{expense.merchant}</span>
        <span className="block text-xs text-ink-3">
          {CATEGORY_LABEL[expense.category]}
          {expense.policyResult === "needs_review" && <span className="text-review"> · needs review</span>}
        </span>
      </span>
      <span className="figure text-sm text-ink">{money(expense.amountCents)}</span>
    </li>
  );
}

/**
 * The ledger: what has actually been submitted. A total for the current month,
 * how it splits by category, and the latest slips. An empty ledger says what
 * will appear here rather than showing zeros dressed up as a dashboard.
 */
export function Ledger({ desk, freshId }: { desk: DeskState; freshId: number | null }) {
  const { summary, from } = desk.month;
  const total = useCountUp(summary.totalCents);

  return (
    <section aria-labelledby="ledger-title" className="rounded-xl border border-line bg-paper p-5">
      <div className="flex items-baseline justify-between gap-3">
        <h2 id="ledger-title" className="text-sm font-semibold text-ink">
          Ledger
        </h2>
        <a href="#/expenses" className="text-sm text-ink-2 underline decoration-line-strong underline-offset-4 hover:text-ink">
          All expenses
        </a>
      </div>

      {desk.recent.length === 0 ? (
        <>
          <p className="mt-4 text-sm text-ink-2">Submitted in {month(from)}</p>
          <p className="figure mt-0.5 text-[1.75rem] leading-tight font-medium text-ink">{money(total)}</p>
          <p className="mt-1.5 text-sm text-ink-2">Each slip you confirm is filed here.</p>
        </>
      ) : (
        <>
          <p className="mt-4 text-sm text-ink-2">Submitted in {month(from)}</p>
          <p className="figure mt-0.5 text-[1.75rem] leading-tight font-medium text-ink" aria-live="polite">
            {money(total)}
          </p>
          <div className="mt-4">
            <SpendingSummary summary={summary} />
          </div>

          <h3 className="mt-6 text-sm font-semibold text-ink">Latest</h3>
          <ul className="mt-1 divide-y divide-line border-t border-line">
            {desk.recent.map((expense) => (
              <LedgerRow key={expense.id} expense={expense} fresh={expense.id === freshId} />
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

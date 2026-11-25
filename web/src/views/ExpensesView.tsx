import { useEffect, useState } from "react";
import { CATEGORIES, type Category, type ExpenseDto, type ExpenseStatus } from "../../../shared/contract";
import * as api from "../api/client";
import { ErrorState } from "../components/ErrorState";
import { Select } from "../components/Select";
import { SpendingSummary } from "../components/ledger/SpendingSummary";
import { CATEGORY_LABEL, day, money, month } from "../lib/format";
import { useExpenso } from "../state/store";

const STATUSES: { value: ExpenseStatus; label: string }[] = [
  { value: "submitted", label: "Submitted" },
  { value: "draft", label: "Draft" },
  { value: "cancelled", label: "Discarded" },
];

const EMPTY: Record<ExpenseStatus, string> = {
  submitted: "Nothing submitted yet. Slips you confirm are listed here.",
  draft: "No draft at the moment. A draft appears when you send a receipt or describe an expense.",
  cancelled: "Nothing discarded. Drafts you discard or replace are kept here for reference.",
};

type Loaded = { state: "loading" } | { state: "ready"; expenses: ExpenseDto[] } | { state: "failed" };

/** Everything the user has filed, read straight from the backend. No model involved. */
export function ExpensesView() {
  const { state } = useExpenso();
  const [status, setStatus] = useState<ExpenseStatus>("submitted");
  const [category, setCategory] = useState<Category | "">("");
  const [loaded, setLoaded] = useState<Loaded>({ state: "loading" });
  const [attempt, setAttempt] = useState(0);

  // Refetched whenever a turn may have changed what is filed.
  useEffect(() => {
    let current = true;
    api
      .listExpenses({ status, category: category || undefined })
      .then((expenses) => current && setLoaded({ state: "ready", expenses }))
      .catch(() => current && setLoaded({ state: "failed" }));
    return () => {
      current = false;
    };
  }, [status, category, state.ledgerVersion, attempt]);

  return (
    <main className="mx-auto w-full max-w-4xl flex-1 px-4 py-8 sm:px-8">
      <h1 className="text-[1.75rem] font-semibold tracking-tight">Expenses</h1>
      <p className="mt-1 text-ink-2">Submitted means sent for processing. It does not mean approved or reimbursed.</p>

      {/* The same backend figures the ledger shows; nothing here is computed in the browser. */}
      {state.desk && (
        <section
          aria-label={`Submitted in ${month(state.desk.month.from)}`}
          className="mt-6 grid gap-x-10 gap-y-5 rounded-2xl border border-line bg-paper p-5 shadow-(--shadow-lift) sm:grid-cols-[auto_minmax(0,1fr)] sm:p-6"
        >
          <div>
            <p className="text-sm text-ink-2">Submitted in {month(state.desk.month.from)}</p>
            <p className="figure mt-1 text-[2rem] leading-none font-medium">{money(state.desk.month.summary.totalCents)}</p>
            <p className="mt-2.5 text-sm text-ink-2">
              {state.desk.month.summary.count} {state.desk.month.summary.count === 1 ? "expense" : "expenses"}
              {state.desk.month.summary.needsReviewCount > 0 && (
                <span className="text-review"> · {state.desk.month.summary.needsReviewCount} in manual review</span>
              )}
            </p>
          </div>
          <div className="self-center">
            {state.desk.month.summary.count > 0 ? (
              <SpendingSummary summary={{ ...state.desk.month.summary, needsReviewCount: 0 }} />
            ) : (
              <p className="max-w-[44ch] text-sm text-ink-2">
                Nothing submitted this month yet. The split by category appears here once you confirm a slip.
              </p>
            )}
          </div>
        </section>
      )}

      <div className="mt-6 flex flex-wrap items-center gap-3">
        <div role="group" aria-label="Status" className="inline-flex rounded-lg border border-line-strong bg-paper p-0.5">
          {STATUSES.map((option) => (
            <button
              key={option.value}
              type="button"
              aria-pressed={status === option.value}
              onClick={() => setStatus(option.value)}
              className={`min-h-10 rounded-md px-3 text-sm transition-colors ${
                status === option.value ? "bg-indigo-wash font-medium text-indigo-deep" : "text-ink-2 hover:text-ink"
              }`}
            >
              {option.label}
            </button>
          ))}
        </div>

        <label className="flex items-center gap-2 text-sm text-ink-2">
          Category
          <Select value={category} onChange={(event) => setCategory(event.target.value as Category | "")}>
            <option value="">All</option>
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {CATEGORY_LABEL[c]}
              </option>
            ))}
          </Select>
        </label>
      </div>

      <div className="mt-5">
        {loaded.state === "loading" && (
          <div className="space-y-2.5" aria-busy="true" aria-label="Loading expenses">
            {[0, 1, 2].map((i) => (
              <div key={i} className="skeleton h-11" />
            ))}
          </div>
        )}

        {loaded.state === "failed" && (
          <ErrorState onRetry={() => { setLoaded({ state: "loading" }); setAttempt((n) => n + 1); }}>
            The expenses could not be loaded.
          </ErrorState>
        )}

        {loaded.state === "ready" && loaded.expenses.length === 0 && (
          <p className="max-w-[52ch] rounded-lg border border-dashed border-line-strong px-4 py-6 text-ink-2">
            {EMPTY[status]}{" "}
            <a href="#/assistant" className="text-indigo underline underline-offset-4">
              Go to the assistant
            </a>
          </p>
        )}

        {loaded.state === "ready" && loaded.expenses.length > 0 && (
          <div className="overflow-x-auto rounded-xl border border-line bg-paper">
            <table className="w-full min-w-[34rem] text-left text-sm">
              <thead>
                <tr className="border-b border-line text-ink-2">
                  <th scope="col" className="px-4 py-2.5 font-medium">Date</th>
                  <th scope="col" className="px-4 py-2.5 font-medium">Merchant</th>
                  <th scope="col" className="px-4 py-2.5 font-medium">Category</th>
                  <th scope="col" className="px-4 py-2.5 font-medium">Policy</th>
                  <th scope="col" className="px-4 py-2.5 text-right font-medium">Amount</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {loaded.expenses.map((expense) => (
                  <tr key={expense.id}>
                    <td className="px-4 py-3 whitespace-nowrap text-ink-2 tabular-nums">{day(expense.expenseDate)}</td>
                    <td className="px-4 py-3">
                      <span className="text-ink">{expense.merchant}</span>
                      {expense.description && <span className="block text-xs text-ink-3">{expense.description}</span>}
                    </td>
                    <td className="px-4 py-3 text-ink-2">{CATEGORY_LABEL[expense.category]}</td>
                    <td className="px-4 py-3">
                      {expense.policyResult === "within_policy" ? (
                        <span className="text-ok">Within policy</span>
                      ) : (
                        <span className="text-review" title={expense.policyNotes ?? undefined}>
                          Needs review
                        </span>
                      )}
                    </td>
                    <td className="figure px-4 py-3 text-right whitespace-nowrap text-ink">{money(expense.amountCents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </main>
  );
}

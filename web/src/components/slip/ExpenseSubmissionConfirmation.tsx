import type { ExpenseDto } from "../../../../shared/contract";
import { CATEGORY_LABEL, day, dayWithWeekday, money } from "../../lib/format";
import { LimitRuler } from "../policy/LimitRuler";
import { PolicyStatus, verdictOf } from "../policy/PolicyStatus";
import { SlipBody, SlipShell, SlipStatus } from "./Slip";

/**
 * An ink stamp. "Submitted" says the slip was handed in; it says nothing about
 * approval, which this product does not decide. A second stamp marks a slip
 * that will be looked at by a person because it is over a limit.
 */
export function Stamp({
  tone,
  title,
  line,
  tilt = -7,
}: {
  tone: "indigo" | "review";
  title: string;
  line?: string;
  /** Degrees. Two stamps on one slip are never perfectly parallel. */
  tilt?: number;
}) {
  return (
    <span
      className={`stamp animate-stamp ${tone === "indigo" ? "text-indigo" : "text-review"}`}
      style={{ "--tilt": `${tilt}deg` } as React.CSSProperties}
    >
      <span>{title}</span>
      {line && <span className="text-2xs font-medium tracking-normal normal-case opacity-90">{line}</span>}
    </span>
  );
}

/**
 * The slip after the user confirmed it: same object, clean edge, stamped. It
 * stays on the desk until the next slip arrives, and it is also in the ledger.
 */
export function ExpenseSubmissionConfirmation({
  expense,
  limitCents,
  photo,
}: {
  expense: ExpenseDto;
  limitCents: number;
  photo?: string | null;
}) {
  const needsReview = expense.policyResult === "needs_review";
  return (
    <SlipShell variant="filed" label="Submitted expense">
      <SlipStatus id={expense.id}>Submitted for processing</SlipStatus>

      {/* The stamps have their own space beside the details, and drop below them on a narrow slip. */}
      <div className={photo === undefined ? "flex items-start justify-between gap-x-3 pr-5" : ""}>
        <SlipBody photo={photo}>
          <p className="figure text-[2rem] leading-none font-medium tracking-tight">{money(expense.amountCents)}</p>
          <p className="mt-3 text-base font-medium break-words">{expense.merchant}</p>
          <p className="mt-0.5 text-sm text-ink-2">
            <span className="tabular-nums">{dayWithWeekday(expense.expenseDate)}</span>
            <span aria-hidden="true" className="mx-2 text-line-strong">
              /
            </span>
            {CATEGORY_LABEL[expense.category]}
          </p>
          {expense.description && <p className="mt-2 text-sm text-ink-2">{expense.description}</p>}
        </SlipBody>

        <div
          className={
            photo === undefined
              ? "flex shrink-0 flex-col items-end gap-3.5 pt-5 pb-4"
              : "flex flex-wrap items-center gap-x-6 gap-y-3 px-6 pt-1 pb-5"
          }
          aria-hidden="true"
        >
          <Stamp tone="indigo" title="Submitted" line={expense.submittedAt ? day(expense.submittedAt) : undefined} />
          {needsReview && <Stamp tone="review" title="Needs review" tilt={4} />}
        </div>
      </div>

      <div className="space-y-2.5 border-t border-line px-5 py-4">
        <LimitRuler category={expense.category} amountCents={expense.amountCents} limitCents={limitCents} />
        <PolicyStatus verdict={verdictOf(expense)} />
      </div>

      <p className="border-t border-line px-5 py-3 text-sm text-ink-2">
        Filed in your ledger{expense.submittedAt ? ` on ${day(expense.submittedAt)}` : ""}. Submitted means sent for
        processing, not yet reimbursed.
      </p>
    </SlipShell>
  );
}

import type { ExpenseDto } from "../../../../shared/contract";
import type { SlipField as FieldName } from "../../lib/diff";
import { CATEGORY_LABEL, dayWithWeekday, money } from "../../lib/format";
import { LimitRuler } from "../policy/LimitRuler";
import { PolicyStatus, verdictOf } from "../policy/PolicyStatus";
import { SlipBody, SlipButton, SlipField, SlipShell, SlipStatus } from "./Slip";

/** What tapping a field puts in the composer. The user finishes the sentence. */
const EDIT_PROMPT: Record<FieldName, string> = {
  amount: "Change the amount to $",
  merchant: "Change the merchant to ",
  date: "Change the date to ",
  category: "Change the category to ",
  description: "Change the note to ",
};

/**
 * The current slip: a draft. It is not submitted and says so. Only the two
 * buttons here (or typing "confirm") can change that; the assistant cannot.
 */
export function ExpenseDraftCard({
  expense,
  limitCents,
  photo,
  highlight,
  busy,
  action,
  onConfirm,
  onCancel,
  onEdit,
}: {
  expense: ExpenseDto;
  /** The per-expense limit for this slip's category, from the backend. */
  limitCents: number;
  /** undefined: this slip did not come from a photo. null: it did, but the photo is gone. */
  photo?: string | null;
  highlight: { fields: FieldName[]; key: number };
  busy: boolean;
  /** Which of this slip's own actions is in flight, if any. */
  action: "confirming" | "cancelling" | null;
  onConfirm: () => void;
  onCancel: () => void;
  onEdit: (text: string) => void;
}) {
  const changed = (field: FieldName) => (highlight.fields.includes(field) ? highlight.key : false);
  const edit = (field: FieldName) => () => onEdit(EDIT_PROMPT[field]);

  return (
    <SlipShell variant="draft" label="Draft expense, not submitted">
      <SlipStatus id={expense.id}>Draft · not submitted</SlipStatus>

      <SlipBody photo={photo}>
        <SlipField label="amount" onEdit={edit("amount")} changed={changed("amount")}>
          <span className="figure text-[2rem] leading-none font-medium tracking-tight">{money(expense.amountCents)}</span>
        </SlipField>

        <SlipField label="merchant" onEdit={edit("merchant")} changed={changed("merchant")} className="mt-3">
          <span className="text-base font-medium break-words">{expense.merchant}</span>
        </SlipField>

        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-sm text-ink-2">
          <SlipField label="date" onEdit={edit("date")} changed={changed("date")}>
            <span className="tabular-nums">{dayWithWeekday(expense.expenseDate)}</span>
          </SlipField>
          <span aria-hidden="true" className="text-line-strong">
            /
          </span>
          <SlipField label="category" onEdit={edit("category")} changed={changed("category")}>
            {CATEGORY_LABEL[expense.category]}
          </SlipField>
        </div>

        {expense.description && (
          <SlipField label="note" onEdit={edit("description")} changed={changed("description")} className="mt-2">
            <span className="text-sm text-ink-2">{expense.description}</span>
          </SlipField>
        )}
      </SlipBody>

      <div className="space-y-2.5 border-t border-line px-5 py-4">
        <LimitRuler
          category={expense.category}
          amountCents={expense.amountCents}
          limitCents={limitCents}
        />
        <PolicyStatus verdict={verdictOf(expense)} />
      </div>

      <div className="px-5 pt-1 pb-4">
        <div className="flex flex-wrap gap-2.5">
          <SlipButton primary onClick={onConfirm} disabled={busy}>
            {action === "confirming" ? "Submitting…" : "Confirm and submit"}
          </SlipButton>
          <SlipButton onClick={onCancel} disabled={busy}>
            {action === "cancelling" ? "Discarding…" : "Discard"}
          </SlipButton>
        </div>
        <p className="mt-2.5 text-xs text-ink-3">Nothing is sent until you confirm. Tap any detail to change it.</p>
      </div>
    </SlipShell>
  );
}

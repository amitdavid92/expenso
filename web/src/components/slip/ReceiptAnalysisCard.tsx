import type { ReceiptAnalysisDto, ReceiptField } from "../../../../shared/contract";
import { CATEGORY_LABEL, dayWithWeekday, receiptAmount } from "../../lib/format";
import { AlertIcon, StopIcon } from "../Icons";
import { SlipBody, SlipButton, SlipShell, SlipStatus } from "./Slip";

/** What tapping a missing field puts in the composer. */
const SUPPLY_PROMPT: Record<ReceiptField, string> = {
  merchant: "The merchant was ",
  amount: "The total was $",
  currency: "The receipt is in ",
  date: "The date was ",
  category: "The category is ",
};

const CURRENCY_NAME: Record<string, string> = { USD: "US dollars", CAD: "Canadian dollars", AUD: "Australian dollars" };

function Row({
  label,
  value,
  missing,
  onSupply,
}: {
  label: string;
  value: string | null;
  missing: boolean;
  onSupply: () => void;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1.5">
      <dt className="text-sm text-ink-2">{label}</dt>
      <dd className="min-w-0 text-right text-sm">
        {value ? (
          <span className="break-words text-ink">{value}</span>
        ) : missing ? (
          <button
            type="button"
            onClick={onSupply}
            className="inline-flex items-center gap-1 rounded font-medium text-review underline decoration-review/40 underline-offset-4 hover:decoration-review"
          >
            <AlertIcon width={14} height={14} />
            Not readable · add it
          </button>
        ) : (
          <span className="text-ink-3">None</span>
        )}
      </dd>
    </div>
  );
}

/**
 * A receipt that was read only in part. It shows what was read, marks what is
 * missing, and never fills a gap with a guess. It is not a draft yet: there is
 * nothing to confirm until every required field is known.
 */
export function ReceiptAnalysisCard({
  analysis,
  photo,
  busy,
  onSupply,
  onAnswerCurrency,
  onDiscard,
}: {
  analysis: ReceiptAnalysisDto;
  photo: string | null;
  busy: boolean;
  onSupply: (text: string) => void;
  onAnswerCurrency: (currency: string) => void;
  onDiscard: () => void;
}) {
  const { fields, missing, status, suggestedCurrency } = analysis;
  const isMissing = (field: ReceiptField) => missing.includes(field);
  const supply = (field: ReceiptField) => () => onSupply(SUPPLY_PROMPT[field]);
  const askCurrency = isMissing("currency") && !!suggestedCurrency;
  const others = missing.filter((field) => !(field === "currency" && askCurrency));

  return (
    <SlipShell variant="draft" label="Receipt waiting for details">
      <SlipStatus>
        {status === "unsupported_currency"
          ? "Receipt read · currency not supported"
          : status === "blocked_by_policy"
            ? "Receipt read · can't be submitted"
            : "Receipt read in part"}
      </SlipStatus>

      <SlipBody photo={photo}>
        <dl className="divide-y divide-line">
          <Row label="Merchant" value={fields.merchant} missing={isMissing("merchant")} onSupply={supply("merchant")} />
          <Row label="Total" value={receiptAmount(fields)} missing={isMissing("amount")} onSupply={supply("amount")} />
          <Row
            label="Currency"
            value={fields.currency}
            missing={isMissing("currency") && !askCurrency}
            onSupply={supply("currency")}
          />
          <Row
            label="Date"
            value={fields.expenseDate ? dayWithWeekday(fields.expenseDate) : null}
            missing={isMissing("date")}
            onSupply={supply("date")}
          />
          <Row
            label="Category"
            value={fields.category ? CATEGORY_LABEL[fields.category] : null}
            missing={isMissing("category")}
            onSupply={supply("category")}
          />
          {fields.description && <Row label="Note" value={fields.description} missing={false} onSupply={() => {}} />}
        </dl>
      </SlipBody>

      <div className="space-y-3 border-t border-line px-5 pt-4 pb-4">
        {askCurrency && (
          <div>
            <p className="text-sm text-ink">
              The receipt shows a currency symbol but not which currency. Is the total in{" "}
              {CURRENCY_NAME[suggestedCurrency!] ?? suggestedCurrency}?
            </p>
            <div className="mt-2.5 flex gap-2.5">
              <SlipButton primary onClick={() => onAnswerCurrency(suggestedCurrency!)} disabled={busy}>
                Yes, {CURRENCY_NAME[suggestedCurrency!] ?? suggestedCurrency}
              </SlipButton>
              <SlipButton onClick={supply("currency")} disabled={busy}>
                Another currency
              </SlipButton>
            </div>
          </div>
        )}

        {status === "unsupported_currency" && (
          <div className="flex gap-2 text-sm text-review">
            <AlertIcon width={16} height={16} className="mt-0.5 shrink-0" />
            <p>
              <span className="font-medium">Only USD expenses are supported.</span>{" "}
              <span className="text-ink-2">Amounts are never converted for you.</span>
            </p>
          </div>
        )}

        {status === "blocked_by_policy" && (
          <div className="flex gap-2 text-sm text-stop">
            <StopIcon width={16} height={16} className="mt-0.5 shrink-0" />
            <p>
              <span className="font-medium">Can't be submitted.</span>{" "}
              <span className="text-ink-2">{analysis.reasons.join(" ")}</span>
            </p>
          </div>
        )}

        {others.length > 0 && status === "needs_details" && (
          <p className="text-sm text-ink-2">
            Still needed: <span className="font-medium text-ink">{others.join(", ")}</span>. Tap a missing detail, or
            just tell me.
          </p>
        )}

        <div className="flex flex-wrap gap-2.5">
          {status === "unsupported_currency" && (
            <SlipButton primary onClick={() => onSupply("The amount in USD was $")} disabled={busy}>
              Give the USD amount
            </SlipButton>
          )}
          {status === "blocked_by_policy" && (
            <SlipButton onClick={supply("date")} disabled={busy}>
              Correct the date
            </SlipButton>
          )}
          <SlipButton onClick={onDiscard} disabled={busy}>
            Discard
          </SlipButton>
        </div>
        <p className="text-xs text-ink-3">Not a draft yet. Nothing is filled in by guesswork.</p>
      </div>
    </SlipShell>
  );
}

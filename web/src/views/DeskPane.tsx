import { Ledger } from "../components/ledger/Ledger";
import { DropZone, SlipReading } from "../components/slip/DropZone";
import { ExpenseDraftCard } from "../components/slip/ExpenseDraftCard";
import { ExpenseSubmissionConfirmation } from "../components/slip/ExpenseSubmissionConfirmation";
import { ReceiptAnalysisCard } from "../components/slip/ReceiptAnalysisCard";
import { isBusy, useExpenso } from "../state/store";

/**
 * The desk: the slip being worked on, and below it the ledger of slips already
 * handed in. Exactly one thing occupies the top at a time, chosen from what
 * the server says is true.
 */
export function DeskPane() {
  const { state, actions } = useExpenso();
  const desk = state.desk;
  if (!desk) return null;

  const busy = isBusy(state);
  const turn = state.turn;
  const slip = desk.currentSlip;

  let current: React.ReactNode;
  if (turn.kind === "reading_receipt") {
    current = <SlipReading photo={state.slipPreview} startedAt={turn.startedAt} />;
  } else if (slip) {
    current = (
      <ExpenseDraftCard
        expense={slip}
        limitCents={desk.limits[slip.category]}
        photo={state.slipPreview ?? undefined}
        highlight={state.highlight}
        busy={busy}
        action={turn.kind === "confirming" || turn.kind === "cancelling" ? turn.kind : null}
        onConfirm={() => actions.confirm(slip.id)}
        onCancel={() => actions.cancel(slip.id)}
        onEdit={actions.seedComposer}
      />
    );
  } else if (desk.pendingReceipt) {
    current = (
      <ReceiptAnalysisCard
        analysis={desk.pendingReceipt}
        photo={state.slipPreview}
        busy={busy}
        onSupply={actions.seedComposer}
        onAnswerCurrency={actions.answerCurrency}
        onDiscard={actions.discardReceipt}
      />
    );
  } else if (state.filed) {
    current = (
      <>
        <ExpenseSubmissionConfirmation
          expense={state.filed}
          limitCents={desk.limits[state.filed.category]}
          photo={state.slipPreview ?? undefined}
        />
        <p className="mt-4 text-sm text-ink-2">
          Ready for the next one: drop a receipt anywhere on this page, or describe an expense.
        </p>
      </>
    );
  } else {
    current = <DropZone onFile={(file) => actions.sendReceipt(file)} onSample={actions.sendSampleReceipt} disabled={busy} />;
  }

  return (
    <div className="space-y-9">
      <div>
        <h2 className="mb-3 text-sm font-semibold text-ink">Your expense slip</h2>
        {/* Announces what the slip is now, for people who cannot see it change. */}
        <p className="sr-only" role="status">
          {turn.kind === "reading_receipt"
            ? "Reading your receipt."
            : slip
              ? "A draft is waiting for your confirmation."
              : desk.pendingReceipt
                ? "A receipt is waiting for more details."
                : state.filed
                  ? "The expense was submitted."
                  : "No expense in progress."}
        </p>
        {current}
      </div>
      <Ledger desk={desk} freshId={state.filed?.id ?? null} />
    </div>
  );
}

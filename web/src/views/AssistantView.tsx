import { type DragEvent, useState } from "react";
import { Conversation } from "../components/conversation/Conversation";
import { MessageComposer } from "../components/conversation/MessageComposer";
import { Welcome } from "../components/conversation/Welcome";
import { ErrorState } from "../components/ErrorState";
import { firstImage } from "../components/slip/DropZone";
import { describePendingReceipt, money } from "../lib/format";
import { useIsWide } from "../state/hooks";
import { isBusy, useExpenso } from "../state/store";
import { DeskPane } from "./DeskPane";

/**
 * On a phone the desk is its own tab, so this bar keeps the slip in reach from
 * the conversation: what is pending, and the one action that matters.
 */
function SlipBar() {
  const { state, actions } = useExpenso();
  const slip = state.desk?.currentSlip;
  const pending = state.desk?.pendingReceipt;
  if (!slip && !pending) return null;
  const busy = isBusy(state);
  const waiting = pending ? describePendingReceipt(pending) : null;

  return (
    <div className="mb-2 flex items-center gap-3 rounded-xl border border-dashed border-line-strong bg-paper px-3.5 py-2 desk:hidden">
      <a href="#/desk" className="min-w-0 flex-1 rounded">
        <span className="block text-xs text-ink-2">
          {slip ? (
            <>
              Draft · not submitted ·{" "}
              {slip.policyResult === "within_policy" ? (
                <span className="text-ok">within policy</span>
              ) : (
                <span className="text-review">over the limit, goes to review</span>
              )}
            </>
          ) : (
            <span className={waiting!.blocked ? "text-stop" : undefined}>{waiting!.title}</span>
          )}
        </span>
        <span className="block truncate text-sm text-ink">
          {slip ? (
            <>
              <span className="figure font-medium">{money(slip.amountCents)}</span> · {slip.merchant}
            </>
          ) : (
            waiting!.detail
          )}
        </span>
      </a>
      {slip ? (
        <button
          type="button"
          onClick={() => {
            // Go to the desk first, so the user sees their slip being stamped.
            window.location.hash = "#/desk";
            actions.confirm(slip.id);
          }}
          disabled={busy}
          className="inline-flex min-h-11 shrink-0 items-center rounded-lg bg-indigo px-3.5 text-sm font-medium text-white disabled:opacity-55"
        >
          Confirm
        </button>
      ) : (
        <a href="#/desk" className="inline-flex min-h-11 shrink-0 items-center rounded-lg border border-line-strong px-3.5 text-sm font-medium text-ink">
          Open
        </a>
      )}
    </div>
  );
}

/**
 * The workspace: the conversation on the left, the desk on the right. On
 * narrow screens only one of them is shown (`show`), chosen by the tab bar.
 */
export function AssistantView({ show }: { show: "conversation" | "desk" }) {
  const { state, actions } = useExpenso();
  const [dragging, setDragging] = useState(false);
  // The longer placeholder needs a roomy composer; beside the desk on a tablet it would be cut off.
  const wide = useIsWide(72);
  const busy = isBusy(state);
  const isNew = state.messages.length === 0 && !state.outgoing;

  // A receipt can be dropped anywhere on the workspace, not only on the slip.
  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    setDragging(false);
    const file = firstImage(event.dataTransfer.files);
    if (file && !busy) actions.sendReceipt(file);
  };

  return (
    <div
      className="grid min-h-0 flex-1 desk:grid-cols-[minmax(0,1fr)_clamp(20rem,38vw,27rem)]"
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes("Files")) {
          event.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={(event) => {
        if (event.currentTarget === event.target) setDragging(false);
      }}
      onDrop={onDrop}
    >
      <main
        className={`min-h-0 min-w-0 flex-col ${show === "conversation" ? "flex" : "hidden desk:flex"} ${dragging ? "bg-indigo-wash/60" : "bg-paper"}`}
      >
        <div data-scroll-pane className="min-h-0 flex-1 overflow-y-auto px-4 sm:px-8">
          {isNew ? (
            <Welcome onPrompt={actions.send} onFile={(file) => actions.sendReceipt(file)} onSample={actions.sendSampleReceipt} disabled={busy} />
          ) : (
            <Conversation
              state={state}
              onRetry={actions.retry}
              layoutKey={`${state.desk?.currentSlip?.id ?? ""}|${state.desk?.pendingReceipt?.status ?? ""}|${state.notice ?? ""}`}
            />
          )}
        </div>

        <div className="px-4 pt-1 pb-3 sm:px-8 sm:pb-5">
          <div className="mx-auto w-full max-w-2xl">
            {state.notice && (
              <div className="mb-2">
                <ErrorState onDismiss={actions.clearNotice}>{state.notice}</ErrorState>
              </div>
            )}
            <SlipBar />
            <MessageComposer
              onSend={actions.send}
              onFile={(file, caption) => actions.sendReceipt(file, caption)}
              disabled={busy}
              seed={state.seed}
              onSeedUsed={actions.seedUsed}
              placeholder={
                state.desk?.currentSlip
                  ? wide ? "Tell me what to change, or ask anything…" : "Tell me what to change…"
                  : wide ? "Describe an expense, ask about policy, or attach a receipt…" : "Describe an expense…"
              }
            />
          </div>
        </div>
      </main>

      <aside
        aria-label="Desk"
        className={`min-h-0 overflow-y-auto border-line bg-desk px-4 py-6 sm:px-6 desk:border-l ${show === "desk" ? "block" : "hidden desk:block"}`}
      >
        <div className="mx-auto max-w-md">
          <DeskPane />
        </div>
      </aside>
    </div>
  );
}

import { useEffect, useRef } from "react";
import { useExpenso } from "../../state/store";
import { AlertIcon, PlaneIcon } from "../Icons";

function plural(count: number, one: string, many: string) {
  return `${count} ${count === 1 ? one : many}`;
}

/**
 * The moment a conversation crosses from Telegram to this browser. Nothing
 * changes until the user says yes here: the card names the account the link
 * opens (so nobody is signed in to someone else's account by a link they
 * didn't ask for) and says what happens to anything this browser already had.
 */
export function LinkCard() {
  const { state, actions } = useExpenso();
  const flow = state.link;
  const primary = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!flow) return;
    primary.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && flow.stage !== "connecting") actions.dismissLink();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [flow, actions]);

  if (!flow) return null;
  const preview = flow.preview;
  const who = preview?.name ?? "your Telegram account";
  const guest = preview?.guest;
  const guestHolds = guest && (guest.submitted > 0 || guest.hasDraft || guest.messages > 0);

  return (
    <div className="fixed inset-0 z-40 grid place-items-center bg-ink/25 p-4 backdrop-blur-[2px]">
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="link-title"
        className="w-full max-w-sm animate-settle rounded-2xl border border-line bg-paper p-6 shadow-(--shadow-slip)"
      >
        {/* Where the conversation is coming from, and where it is going. */}
        <div className="flex items-center gap-2.5" aria-hidden="true">
          <span className="grid size-9 place-items-center rounded-[10px] bg-[#2aabee] text-white">
            <PlaneIcon width={18} height={18} />
          </span>
          <span className="h-px w-8 border-t border-dashed border-line-strong" />
          <span className="grid size-9 place-items-center rounded-[10px] bg-indigo text-sm font-bold text-white">e.</span>
        </div>

        {flow.stage === "checking" && (
          <div aria-busy="true">
            <h2 id="link-title" className="mt-5 text-lg font-semibold">
              Checking your link…
            </h2>
            <div className="skeleton mt-3 h-4 w-56" />
            <div className="skeleton mt-2 h-4 w-40" />
          </div>
        )}

        {flow.stage === "error" && (
          <>
            <h2 id="link-title" className="mt-5 flex items-center gap-2 text-lg font-semibold">
              <AlertIcon width={18} height={18} className="text-stop" />
              Couldn't continue from Telegram
            </h2>
            <p className="mt-2 text-ink-2">{flow.error}</p>
            <p className="mt-2 text-sm text-ink-3">Nothing has changed in this browser.</p>
            <div className="mt-5 flex">
              <button
                ref={primary}
                type="button"
                onClick={actions.dismissLink}
                className="inline-flex min-h-11 items-center rounded-lg border border-line-strong px-4 font-medium text-ink hover:border-ink-3"
              >
                OK
              </button>
            </div>
          </>
        )}

        {(flow.stage === "ready" || flow.stage === "connecting") && preview && (
          <>
            <h2 id="link-title" className="mt-5 text-lg font-semibold tracking-tight">
              {preview.sameAccount ? `You're already connected as ${who}` : `Continue as ${who}?`}
            </h2>
            <p className="mt-1.5 text-ink-2">
              {preview.sameAccount
                ? "This browser already shows your Telegram conversation."
                : "Your Telegram conversation, your current slip and your ledger will open in this browser. Anything you do here also shows in Telegram."}
            </p>

            {guestHolds && guest && (
              <p className="mt-3 rounded-lg bg-desk px-3 py-2.5 text-sm text-ink-2">
                This browser has a guest workspace (
                {[
                  guest.submitted > 0 && plural(guest.submitted, "submitted expense", "submitted expenses"),
                  guest.hasDraft && "a draft",
                  guest.submitted === 0 && !guest.hasDraft && plural(guest.messages, "message", "messages"),
                ]
                  .filter(Boolean)
                  .join(", ")}
                ). It stays as it is and is not added to your Telegram account. Disconnecting brings it back.
              </p>
            )}

            <div className="mt-5 flex flex-wrap gap-2.5">
              <button
                ref={primary}
                type="button"
                onClick={preview.sameAccount ? actions.dismissLink : actions.confirmLink}
                disabled={flow.stage === "connecting"}
                className="inline-flex min-h-11 flex-1 items-center justify-center rounded-lg bg-indigo px-4 font-medium whitespace-nowrap text-white shadow-(--shadow-lift) transition-colors hover:bg-indigo-deep disabled:opacity-60"
              >
                {flow.stage === "connecting" ? "Connecting…" : preview.sameAccount ? "Continue" : `Continue as ${preview.name ?? "me"}`}
              </button>
              {!preview.sameAccount && (
                <button
                  type="button"
                  onClick={actions.dismissLink}
                  disabled={flow.stage === "connecting"}
                  className="inline-flex min-h-11 items-center rounded-lg border border-line-strong px-4 font-medium text-ink hover:border-ink-3 disabled:opacity-60"
                >
                  Not me
                </button>
              )}
            </div>
            {!preview.sameAccount && (
              <p className="mt-3 text-xs text-ink-3">Only continue with a link you asked the Expenso bot for yourself.</p>
            )}
          </>
        )}
      </section>
    </div>
  );
}

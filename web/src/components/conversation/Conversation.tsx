import { useEffect, useRef } from "react";
import { useElapsed } from "../../state/hooks";
import type { State, Turn } from "../../state/reducer";
import { ErrorState } from "../ErrorState";
import { Message } from "./Message";

const WORKING: Record<Exclude<Turn, { kind: "idle" }>["kind"], string> = {
  sending: "Thinking…",
  reading_receipt: "Reading your receipt…",
  confirming: "Submitting…",
  cancelling: "Discarding…",
  answering: "Updating the slip…",
};

/**
 * What the app is doing, in one true phrase, with the real elapsed time. If
 * the AI service is slow it says that, instead of inventing steps.
 */
export function WorkingIndicator({ turn }: { turn: Exclude<Turn, { kind: "idle" }> }) {
  const seconds = useElapsed(turn.startedAt);
  const usesModel = turn.kind === "sending" || turn.kind === "reading_receipt";
  return (
    <div role="status" className="flex animate-settle items-center gap-2.5 text-sm text-ink-2">
      <span className="relative flex size-2">
        <span className="absolute inline-flex size-full animate-ping rounded-full bg-indigo opacity-40" />
        <span className="relative inline-flex size-2 rounded-full bg-indigo" />
      </span>
      <span>
        {WORKING[turn.kind]}
        {usesModel && seconds >= 8 && " The free AI service is busy right now, still working."}
      </span>
      {seconds >= 2 && <span className="figure text-xs text-ink-3">{Math.floor(seconds)}s</span>}
    </div>
  );
}

/**
 * The conversation: the server's messages, then the user's message that is
 * still on its way, then what is happening now. New content is announced to
 * screen readers and scrolled into view.
 */
export function Conversation({
  state,
  onRetry,
  layoutKey,
}: {
  state: State;
  onRetry: () => void;
  /** Changes when something outside the conversation (the slip bar, a notice) takes or frees room below it. */
  layoutKey?: string;
}) {
  const end = useRef<HTMLDivElement>(null);
  const { messages, outgoing, turn, failed } = state;
  const busy = turn.kind !== "idle";
  const count = messages.length;

  // Scroll to the newest content whenever the conversation grows or its state changes.
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  }, [count, outgoing, turn.kind, failed]);

  // On a phone the slip bar appears above the composer after a turn and the
  // keyboard opens and closes: both shrink this pane after the scroll above
  // has run, hiding the newest message. Keep the end in view when that happens.
  useEffect(() => {
    void layoutKey;
    const pane = end.current?.closest("[data-scroll-pane]");
    if (!pane) return;
    const keepEndVisible = () => end.current?.scrollIntoView({ block: "end" });
    keepEndVisible();
    const observer = new ResizeObserver(keepEndVisible);
    observer.observe(pane);
    return () => observer.disconnect();
  }, [layoutKey]);

  return (
    <div role="log" aria-live="polite" aria-label="Conversation" className="mx-auto w-full max-w-2xl space-y-6 pt-7 pb-5">
      {messages.map((message, i) => (
        <Message
          key={message.id}
          message={message}
          photo={state.receiptPreviews[message.id]}
          onRetry={i === count - 1 ? onRetry : undefined}
          busy={busy}
        />
      ))}

      {outgoing && (
        <div className="flex flex-col items-end gap-1.5 opacity-80">
          {outgoing.receiptPreview && (
            <img
              src={outgoing.receiptPreview}
              alt="Receipt you are sending"
              className="h-32 w-auto max-w-40 rounded-lg border border-line object-cover object-top"
            />
          )}
          {outgoing.text && (
            <p className="max-w-[85%] rounded-2xl rounded-br-md bg-ink px-4 py-2.5 text-paper break-words whitespace-pre-wrap">
              {outgoing.text}
            </p>
          )}
        </div>
      )}

      {busy && <WorkingIndicator turn={turn} />}

      {failed && !busy && (
        <ErrorState onRetry={onRetry} retryLabel="Send again">
          {failed.message}
        </ErrorState>
      )}

      <div ref={end} className="h-px" />
    </div>
  );
}

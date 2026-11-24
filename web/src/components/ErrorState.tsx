import type { ReactNode } from "react";
import { AlertIcon, CloseIcon, RetryIcon } from "./Icons";

/**
 * Something went wrong, said plainly, with the way forward next to it. Used
 * for a failed turn in the conversation, a refused upload and a lost connection.
 */
export function ErrorState({
  children,
  onRetry,
  retryLabel = "Try again",
  onDismiss,
  busy = false,
}: {
  children: ReactNode;
  onRetry?: () => void;
  retryLabel?: string;
  onDismiss?: () => void;
  busy?: boolean;
}) {
  return (
    <div role="alert" className="flex max-w-xl items-start gap-2.5 rounded-lg border border-stop/25 bg-stop-wash px-3.5 py-3 text-sm">
      <AlertIcon width={18} height={18} className="mt-px shrink-0 text-stop" />
      <div className="min-w-0 flex-1">
        <p className="text-ink">{children}</p>
        {onRetry && (
          <button
            type="button"
            onClick={onRetry}
            disabled={busy}
            className="mt-2 inline-flex min-h-9 items-center gap-1.5 rounded-md border border-line-strong bg-paper px-3 font-medium text-ink transition-colors hover:border-ink-3 disabled:opacity-50"
          >
            <RetryIcon width={15} height={15} />
            {retryLabel}
          </button>
        )}
      </div>
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss"
          className="-m-1.5 grid size-9 shrink-0 place-items-center rounded-md text-ink-3 hover:text-ink"
        >
          <CloseIcon width={16} height={16} />
        </button>
      )}
    </div>
  );
}

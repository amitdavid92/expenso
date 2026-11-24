import type { ReactNode } from "react";

/**
 * The shared anatomy of a slip. A draft, a receipt being completed and a
 * submitted expense are the same object in different states, so they share
 * one layout: a status line, an optional receipt photo beside the figures,
 * then policy and actions.
 */

export function SlipShell({
  variant,
  children,
  label,
}: {
  variant: "draft" | "filed" | "faded";
  children: ReactNode;
  /** Accessible name for the region, e.g. "Draft expense". */
  label: string;
}) {
  const look = variant === "draft" ? "slip slip-draft" : variant === "filed" ? "slip" : "slip opacity-60";
  return (
    // No entrance animation: the slip is one object that changes state, not a new card each time.
    <section aria-label={label} className={look}>
      {children}
    </section>
  );
}

/** The line at the top of a slip that says what state it is in. */
export function SlipStatus({ children, id }: { children: ReactNode; id?: number }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-line px-5 py-2.5 text-sm">
      <span className="font-medium text-ink">{children}</span>
      {id !== undefined && <span className="text-sm text-ink-3 tabular-nums">No. {id}</span>}
    </div>
  );
}

export function SlipBody({ photo, children }: { photo?: string | null; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-1 gap-4 px-5 pt-4 pb-5">
      {photo !== undefined && <ReceiptPhoto src={photo} />}
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

/**
 * The receipt beside the figures read from it, so one can be checked against
 * the other. The photo exists only in this browser tab: after a reload there
 * is nothing to show, and the placeholder says so.
 */
export function ReceiptPhoto({ src }: { src: string | null }) {
  if (!src) {
    return (
      <div className="grid h-28 w-20 shrink-0 place-items-center rounded-md border border-dashed border-line-strong px-1.5 text-center text-2xs leading-tight text-ink-3">
        Receipt photo not kept
      </div>
    );
  }
  return (
    <a
      href={src}
      target="_blank"
      rel="noreferrer"
      className="block h-28 w-20 shrink-0 overflow-hidden rounded-md border border-line bg-desk"
      title="Open the receipt photo"
    >
      <img src={src} alt="The receipt photo you sent" className="size-full object-cover object-top" />
    </a>
  );
}

/**
 * One value on a slip. When `onEdit` is given it is a button: tapping it puts
 * a ready-to-finish sentence in the composer, so every edit still goes through
 * the conversation, but the slip shows what can be changed.
 */
export function SlipField({
  label,
  children,
  onEdit,
  changed,
  className = "",
}: {
  label: string;
  children: ReactNode;
  onEdit?: () => void;
  /** A changing key restarts the "this just changed" highlight. */
  changed?: number | false;
  className?: string;
}) {
  const content = (
    <span key={changed || undefined} className={`inline-block px-1 -mx-1 ${changed ? "animate-changed" : ""}`}>
      {children}
    </span>
  );
  if (!onEdit) return <div className={className}>{content}</div>;
  return (
    <button
      type="button"
      onClick={onEdit}
      aria-label={`Change ${label}`}
      title={`Change ${label}`}
      className={`block max-w-full rounded text-left decoration-line-strong decoration-dotted underline-offset-[5px] hover:underline ${className}`}
    >
      {content}
    </button>
  );
}

/** A primary or secondary action on a slip. Same two shapes everywhere. */
export function SlipButton({
  children,
  onClick,
  disabled,
  primary = false,
}: {
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  primary?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={
        primary
          ? "inline-flex min-h-11 flex-1 items-center justify-center gap-2 rounded-lg bg-indigo px-4 font-medium whitespace-nowrap text-white transition-colors hover:bg-indigo-deep active:bg-indigo-deep disabled:opacity-55"
          : "inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-line-strong bg-paper px-4 font-medium whitespace-nowrap text-ink transition-colors hover:border-ink-3 disabled:opacity-55"
      }
    >
      {children}
    </button>
  );
}

import { useEffect, useRef, useState } from "react";
import type { Route } from "../../state/hooks";
import { isBusy, useExpenso } from "../../state/store";
import { NewIcon, PlaneIcon } from "../Icons";

const TABS: { route: Route; label: string }[] = [
  { route: "assistant", label: "Assistant" },
  { route: "expenses", label: "Expenses" },
  { route: "policy", label: "Policy" },
];

/**
 * Where the Telegram connection will live. Today it only explains what is
 * coming; it makes no claim that anything is connected.
 */
export function TelegramEntry() {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && setOpen(false);
    const onClick = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onClick);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onClick);
    };
  }, [open]);

  return (
    <div ref={root} className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-controls="telegram-panel"
        className="inline-flex min-h-10 items-center gap-1.5 rounded-lg border border-line px-2.5 text-sm text-ink transition-colors hover:border-line-strong hover:bg-desk"
      >
        <PlaneIcon width={17} height={17} />
        <span className="hidden sm:inline">Telegram</span>
        <span className="hidden rounded bg-desk-deep px-1.5 py-0.5 text-2xs font-medium text-ink-2 lg:inline">Soon</span>
      </button>
      {open && (
        <div
          id="telegram-panel"
          role="dialog"
          aria-label="Telegram"
          className="absolute top-full right-0 z-20 mt-2 w-72 animate-settle rounded-xl border border-line-strong bg-paper p-4 shadow-[0_12px_32px_-12px_oklch(0.23_0.03_268/0.25)]"
        >
          <p className="font-medium text-ink">Continue on Telegram</p>
          <p className="mt-1.5 text-sm text-ink-2">
            Not connected yet. Soon you will be able to send a receipt from your phone to the Expenso bot and pick the
            same slip up here.
          </p>
          <p className="mt-2.5 text-sm text-ink-3">Coming in a later phase of this demo.</p>
        </div>
      )}
    </div>
  );
}

/**
 * Starts over: clears the conversation and brings back the first screen. It
 * asks once before doing it, in place, because the conversation cannot be
 * brought back. Submitted expenses and any draft are not affected, and the
 * question says so.
 */
export function NewConversation() {
  const { state, actions } = useExpenso();
  const [asking, setAsking] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const confirm = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!asking) return;
    confirm.current?.focus();
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && setAsking(false);
    const onClick = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) setAsking(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onClick);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onClick);
    };
  }, [asking]);

  // Nothing to clear on the first screen.
  if (state.messages.length === 0) return null;

  return (
    <div ref={root} className="relative">
      <button
        type="button"
        onClick={() => setAsking((value) => !value)}
        disabled={isBusy(state)}
        aria-expanded={asking}
        aria-controls="new-conversation-panel"
        title="New conversation"
        className="inline-flex min-h-10 items-center gap-1.5 rounded-lg px-2.5 text-sm text-ink-2 transition-colors hover:bg-desk hover:text-ink disabled:opacity-50"
      >
        <NewIcon width={17} height={17} />
        <span className="hidden whitespace-nowrap lg:inline">New conversation</span>
        <span className="sr-only lg:hidden">New conversation</span>
      </button>
      {asking && (
        <div
          id="new-conversation-panel"
          role="dialog"
          aria-label="Start a new conversation"
          className="absolute top-full right-0 z-20 mt-2 w-72 animate-settle rounded-xl border border-line-strong bg-paper p-4 shadow-[0_12px_32px_-12px_oklch(0.23_0.03_268/0.25)]"
        >
          <p className="font-medium text-ink">Start a new conversation?</p>
          <p className="mt-1.5 text-sm text-ink-2">
            This clears the messages here and cannot be undone. Your submitted expenses and any draft on the desk stay
            as they are.
          </p>
          <div className="mt-3 flex gap-2">
            <button
              ref={confirm}
              type="button"
              onClick={() => {
                setAsking(false);
                window.location.hash = "#/assistant";
                actions.newConversation();
              }}
              className="inline-flex min-h-10 items-center rounded-lg bg-indigo px-3.5 text-sm font-medium text-white transition-colors hover:bg-indigo-deep"
            >
              Clear and start over
            </button>
            <button
              type="button"
              onClick={() => setAsking(false)}
              className="inline-flex min-h-10 items-center rounded-lg border border-line-strong px-3.5 text-sm font-medium text-ink transition-colors hover:border-ink-3"
            >
              Keep it
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export function TopBar({ route }: { route: Route }) {
  const active = route === "desk" ? "assistant" : route;
  return (
    <header className="sticky top-0 z-10 border-b border-line bg-paper/95 backdrop-blur-sm">
      <div className="mx-auto flex h-14 max-w-[90rem] items-center gap-3 px-4 sm:px-6">
        <a href="#/assistant" className="flex items-center gap-2 rounded-md pr-2 font-medium tracking-tight text-ink">
          {/* The full stop is the mark: the same one that ends "Snap. Chat. Submit." */}
          <span className="grid size-8 place-items-center rounded-[9px] bg-indigo text-[1.0625rem] leading-none font-bold tracking-tight text-white" aria-hidden="true">
            e.
          </span>
          <span className="text-[1.1875rem] font-bold tracking-[-0.03em]">
            expenso<span className="text-indigo">.</span>
          </span>
        </a>

        <nav aria-label="Main" className="ml-3 hidden items-center gap-1 desk:flex">
          {TABS.map((tab) => (
            <a
              key={tab.route}
              href={`#/${tab.route}`}
              aria-current={active === tab.route ? "page" : undefined}
              className={`inline-flex min-h-10 items-center rounded-lg px-3 text-sm transition-colors ${
                active === tab.route ? "bg-indigo-wash font-semibold text-indigo-deep" : "text-ink-2 hover:bg-desk hover:text-ink"
              }`}
            >
              {tab.label}
            </a>
          ))}
        </nav>

        <div className="ml-auto flex items-center gap-1.5">
          <NewConversation />
          <TelegramEntry />
          <span
            className="rounded-md border border-line px-2 py-1 text-xs whitespace-nowrap text-ink-2"
            title="This is a demo. The expenses, receipts and company policy are fictional. Do not upload real receipts."
          >
            Demo <span className="hidden text-ink-3 lg:inline">· fictional data</span>
          </span>
        </div>
      </div>
    </header>
  );
}

/** The same destinations on a phone, within thumb reach. "Desk" exists only here: on wide screens it is beside the conversation. */
export function TabBar({ route, hasSlip }: { route: Route; hasSlip: boolean }) {
  const tabs: { route: Route; label: string }[] = [
    { route: "assistant", label: "Assistant" },
    { route: "desk", label: "Desk" },
    { route: "expenses", label: "Expenses" },
    { route: "policy", label: "Policy" },
  ];
  return (
    <nav aria-label="Main" className="sticky bottom-0 z-10 grid grid-cols-4 border-t border-line bg-paper pb-[env(safe-area-inset-bottom)] desk:hidden">
      {tabs.map((tab) => (
        <a
          key={tab.route}
          href={`#/${tab.route}`}
          aria-current={route === tab.route ? "page" : undefined}
          className={`relative grid min-h-12 place-items-center text-sm ${
            route === tab.route ? "font-medium text-indigo-deep" : "text-ink-2"
          }`}
        >
          {tab.label}
          {tab.route === "desk" && hasSlip && route !== "desk" && (
            <span className="absolute top-2.5 right-[calc(50%-1.6rem)] size-1.5 rounded-full bg-indigo">
              <span className="sr-only">A slip is waiting</span>
            </span>
          )}
          {route === tab.route && <span className="absolute inset-x-5 top-0 h-0.5 rounded-full bg-indigo" aria-hidden="true" />}
        </a>
      ))}
    </nav>
  );
}

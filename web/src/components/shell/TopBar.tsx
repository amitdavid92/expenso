import { useEffect, useRef, useState } from "react";
import type { Route } from "../../state/hooks";
import { isBusy, useExpenso } from "../../state/store";
import { NewIcon, PlaneIcon } from "../Icons";

const TABS: { route: Route; label: string }[] = [
  { route: "assistant", label: "Assistant" },
  { route: "expenses", label: "Expenses" },
  { route: "policy", label: "Policy" },
];

const BOT_URL = "https://t.me/GetExpensoBot";

/**
 * The Telegram connection: whether this browser shows the same conversation as
 * the Expenso bot, and the way in or out. A guest connects with the one-time
 * code the bot sends (for a computer without Telegram); a phone just taps the
 * link in Telegram instead.
 */
export function TelegramEntry() {
  const { state, actions } = useExpenso();
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState("");
  const root = useRef<HTMLDivElement>(null);
  const account = state.account;
  const connected = account?.kind === "telegram";

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

  const name = connected ? (account.name ?? "Telegram") : null;

  return (
    <div ref={root} className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-controls="telegram-panel"
        className="inline-flex min-h-10 items-center gap-1.5 rounded-lg border border-line px-2.5 text-sm text-ink transition-colors hover:border-line-strong hover:bg-desk"
      >
        <span className="relative">
          <PlaneIcon width={17} height={17} />
          {connected && <span className="absolute -right-0.5 -bottom-0.5 size-2 rounded-full bg-ok ring-2 ring-paper" aria-hidden="true" />}
        </span>
        <span className="hidden max-w-32 truncate sm:inline">{connected ? name : "Telegram"}</span>
        <span className="sr-only">{connected ? `Connected to Telegram as ${name}` : "Telegram: not connected"}</span>
      </button>

      {open && (
        <div
          id="telegram-panel"
          role="dialog"
          aria-label="Telegram connection"
          className="absolute top-full right-0 z-20 mt-2 w-80 animate-settle rounded-xl border border-line-strong bg-paper p-4 shadow-(--shadow-slip)"
        >
          {connected ? (
            <>
              <p className="flex items-center gap-2 font-semibold text-ink">
                <span className="size-2 rounded-full bg-ok" aria-hidden="true" />
                Connected to Telegram{account.name ? ` as ${account.name}` : ""}
              </p>
              <p className="mt-1.5 text-sm text-ink-2">
                This browser shows the same conversation, slip and ledger as the Expenso bot. A change in either place
                shows in both.
              </p>
              <div className="mt-3.5 flex flex-wrap gap-2">
                <a
                  href={BOT_URL}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex min-h-10 items-center rounded-lg border border-line-strong px-3 text-sm font-medium text-ink hover:border-ink-3"
                >
                  Open the bot ↗
                </a>
                <button
                  type="button"
                  onClick={() => {
                    setOpen(false);
                    actions.disconnect();
                  }}
                  className="inline-flex min-h-10 items-center rounded-lg px-3 text-sm font-medium text-stop hover:bg-stop-wash"
                >
                  Disconnect this browser
                </button>
              </div>
              <p className="mt-2.5 text-xs text-ink-3">
                {account.returnsToGuest
                  ? "Disconnecting brings back the guest workspace this browser had before."
                  : "Your expenses stay in your account. /signout in Telegram signs every browser out."}
              </p>
            </>
          ) : (
            <>
              <p className="font-semibold text-ink">Continue from Telegram</p>
              <p className="mt-1.5 text-sm text-ink-2">
                Start with a receipt photo in Telegram, finish here. Send <b className="font-medium text-ink">/web</b> to the{" "}
                <a href={BOT_URL} target="_blank" rel="noreferrer" className="text-indigo underline underline-offset-4">
                  Expenso bot
                </a>{" "}
                and tap its link, or type the code it sends:
              </p>
              <form
                className="mt-3 flex gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (!code.trim()) return;
                  setOpen(false);
                  actions.startLink({ code: code.trim() });
                  setCode("");
                }}
              >
                <label htmlFor="link-code" className="sr-only">
                  Code from Telegram
                </label>
                <input
                  id="link-code"
                  value={code}
                  onChange={(event) => setCode(event.target.value)}
                  placeholder="K7QM-4XPD"
                  autoComplete="one-time-code"
                  autoCapitalize="characters"
                  spellCheck={false}
                  maxLength={12}
                  className="figure min-h-10 w-full min-w-0 flex-1 rounded-lg border border-line-strong bg-paper px-3 text-base tracking-wider uppercase outline-none focus:border-indigo"
                />
                <button
                  type="submit"
                  disabled={!code.trim()}
                  className="inline-flex min-h-10 shrink-0 items-center rounded-lg bg-indigo px-3.5 text-sm font-medium text-white hover:bg-indigo-deep disabled:opacity-50"
                >
                  Connect
                </button>
              </form>
              <p className="mt-2.5 text-xs text-ink-3">The code works once and expires in 10 minutes.</p>
            </>
          )}
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

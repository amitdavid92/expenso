import {
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
} from "react";
import type { TurnResult } from "../../../shared/contract";
import * as api from "../api/client";
import { type LinkCredential, RequestError } from "../api/client";
import { prepareImage } from "../lib/image";
import { type Outgoing, type State, type Turn, initialState, reducer } from "./reducer";

type ActiveTurn = Exclude<Turn, { kind: "idle" }>["kind"];

/** What can be sent again if it got no answer, or if the model failed. */
type Attempt = { kind: "chat"; text: string } | { kind: "receipt"; image: Blob; caption: string; preview: string };

export interface Actions {
  boot: () => void;
  send: (text: string) => void;
  /** Sends a receipt photo. `caption` is whatever the user typed alongside it. */
  sendReceipt: (file: Blob, caption?: string) => void;
  /** Fetches the bundled fictional receipt and sends it like any other photo. */
  sendSampleReceipt: () => void;
  confirm: (expenseId: number) => void;
  cancel: (expenseId: number) => void;
  /** Discards a half-read receipt that is waiting for details. */
  discardReceipt: () => void;
  answerCurrency: (currency: string) => void;
  /** Sends the last message or photo again. */
  retry: () => void;
  /** Clears the conversation and returns to the first screen. Expenses and any draft are kept. */
  newConversation: () => void;
  /** Checks a Telegram link or code and asks the user to confirm. */
  startLink: (credential: LinkCredential) => void;
  /** The user confirmed: connect this browser to that Telegram account. */
  confirmLink: () => void;
  dismissLink: () => void;
  /** Signs this browser out of its Telegram account. */
  disconnect: () => void;
  /** Puts text in the composer for the user to finish. */
  seedComposer: (text: string) => void;
  seedUsed: () => void;
  clearNotice: () => void;
}

const Context = createContext<{ state: State; actions: Actions } | null>(null);

/**
 * A handoff link carries its one-time key in the fragment (#link=…), which
 * never reaches a server. This takes the key and removes it from the address
 * bar and the history at once, so it is not left behind for anyone else.
 */
function takeLinkFromAddress(): string | null {
  const match = /^#link=([A-Za-z0-9_-]{20,200})$/.exec(window.location.hash);
  if (!match) return null;
  window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}#/assistant`);
  return match[1] ?? null;
}

export function ExpensoProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const busy = useRef(false);
  const lastAttempt = useRef<Attempt | null>(null);

  const linkRef = useRef(state.link);
  linkRef.current = state.link;

  const startLink = useCallback((credential: LinkCredential) => {
    dispatch({ type: "link_started", credential });
    api
      .previewLink(credential)
      .then((preview) => dispatch({ type: "link_previewed", preview }))
      .catch((error: unknown) =>
        dispatch({
          type: "link_failed",
          message: error instanceof RequestError ? error.message : "Something went wrong. Please try again.",
        }),
      );
  }, []);

  const boot = useCallback(() => {
    const token = takeLinkFromAddress();

    api
      .openSession()
      .then((bootstrap) => {
        dispatch({ type: "booted", bootstrap });
        if (token) startLink({ token });
      })
      .catch(() => dispatch({ type: "boot_failed" }));
  }, [startLink]);

  useEffect(boot, [boot]);

  // A link opened in a tab where Expenso is already running changes only the fragment.
  const isReady = state.status === "ready";
  useEffect(() => {
    if (!isReady) return;
    const onHash = () => {
      const token = takeLinkFromAddress();
      if (token) startLink({ token });
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, [isReady, startLink]);

  // One conversation, two channels: when the user comes back to this tab (and
  // every 20 seconds while it is in view and connected), read the server again,
  // so a receipt sent or a slip confirmed in Telegram shows up here.
  const connected = state.account?.kind === "telegram";
  const ready = state.status === "ready";
  useEffect(() => {
    if (!ready) return;
    let inFlight = false;
    const refresh = () => {
      if (document.visibilityState !== "visible" || busy.current || inFlight || linkRef.current) return;
      inFlight = true;
      api
        .openSession()
        .then((bootstrap) => dispatch({ type: "refreshed", bootstrap }))
        .catch(() => {})
        .finally(() => {
          inFlight = false;
        });
    };
    const onVisible = () => document.visibilityState === "visible" && refresh();
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", refresh);
    const timer = connected ? window.setInterval(refresh, 20_000) : undefined;
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", refresh);
      if (timer) window.clearInterval(timer);
    };
  }, [ready, connected]);

  /** Runs one turn. Only one runs at a time; a second request while busy is ignored. */
  const run = useCallback(
    async (kind: ActiveTurn, call: () => Promise<TurnResult>, outgoing?: Outgoing) => {
      if (busy.current) return;
      busy.current = true;
      dispatch({ type: "turn_started", turn: { kind, startedAt: Date.now() }, outgoing });
      try {
        dispatch({ type: "turn_finished", result: await call() });
      } catch (error) {
        if (error instanceof RequestError && error.code !== "network") {
          // The server answered, and the answer was no.
          dispatch({ type: "turn_rejected", message: error.message });
        } else {
          // No answer: find out whether the request arrived before offering a retry.
          const bootstrap = await api.openSession().catch(() => null);
          dispatch({
            type: "turn_lost",
            bootstrap,
            message: "I couldn't reach the server. Check your connection and try again.",
          });
        }
      } finally {
        busy.current = false;
      }
    },
    [],
  );

  const actions = useMemo<Actions>(() => {
    const send = (raw: string) => {
      const text = raw.trim();
      if (!text) return;
      lastAttempt.current = { kind: "chat", text };
      void run("sending", () => api.sendChat(text), { text });
    };

    const sendPrepared = (image: Blob, caption: string, preview: string) => {
      lastAttempt.current = { kind: "receipt", image, caption, preview };
      void run("reading_receipt", () => api.sendReceipt(image, caption), {
        text: caption,
        receiptPreview: preview,
      });
    };

    const sendReceipt = (file: Blob, caption = "") => {
      if (busy.current) return;
      // The preview shows the user's own file; what is uploaded is the prepared copy.
      const preview = URL.createObjectURL(file);
      void prepareImage(file).then((image) => sendPrepared(image, caption.trim(), preview));
    };

    return {
      boot,
      send,
      sendReceipt,
      sendSampleReceipt: () => {
        if (busy.current) return;
        fetch("/samples/receipt-cafe-aurora.png")
          .then((response) => (response.ok ? response.blob() : Promise.reject()))
          .then((blob) => sendReceipt(blob))
          .catch(() => dispatch({ type: "turn_rejected", message: "The sample receipt could not be loaded." }));
      },
      confirm: (id) => void run("confirming", () => api.confirmExpense(id)),
      cancel: (id) => void run("cancelling", () => api.cancelExpense(id)),
      // "cancel" is an exact command the backend handles without the model.
      discardReceipt: () => void run("cancelling", () => api.sendChat("cancel"), { text: "cancel" }),
      answerCurrency: (currency) => void run("answering", () => api.answerCurrency(currency)),
      retry: () => {
        const attempt = lastAttempt.current;
        if (!attempt) return;
        if (attempt.kind === "chat") send(attempt.text);
        else sendPrepared(attempt.image, attempt.caption, attempt.preview);
      },
      newConversation: () => {
        if (busy.current) return;
        busy.current = true;
        lastAttempt.current = null;
        api
          .resetConversation()
          .then((bootstrap) => dispatch({ type: "conversation_reset", bootstrap }))
          .catch(() => dispatch({ type: "turn_rejected", message: "The conversation could not be cleared. Please try again." }))
          .finally(() => {
            busy.current = false;
          });
      },
      startLink,
      confirmLink: () => {
        const flow = linkRef.current;
        if (!flow || flow.stage !== "ready" || busy.current) return;
        busy.current = true;
        dispatch({ type: "link_connecting" });
        api
          .redeemLink(flow.credential)
          .then((bootstrap) => {
            dispatch({ type: "workspace_replaced", bootstrap });
            dispatch({ type: "link_closed" });
            window.location.hash = "#/assistant";
          })
          .catch((error: unknown) =>
            dispatch({
              type: "link_failed",
              message: error instanceof RequestError ? error.message : "Something went wrong. Please try again.",
            }),
          )
          .finally(() => {
            busy.current = false;
          });
      },
      dismissLink: () => dispatch({ type: "link_closed" }),
      disconnect: () => {
        if (busy.current) return;
        busy.current = true;
        api
          .disconnectBrowser()
          .then((bootstrap) => dispatch({ type: "workspace_replaced", bootstrap }))
          .catch(() => dispatch({ type: "turn_rejected", message: "This browser could not be disconnected. Please try again." }))
          .finally(() => {
            busy.current = false;
          });
      },
      seedComposer: (text) => dispatch({ type: "seed", text }),
      seedUsed: () => dispatch({ type: "seed_used" }),
      clearNotice: () => dispatch({ type: "notice_cleared" }),
    };
  }, [boot, run, startLink]);

  const value = useMemo(() => ({ state, actions }), [state, actions]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useExpenso() {
  const value = useContext(Context);
  if (!value) throw new Error("useExpenso must be used inside ExpensoProvider");
  return value;
}

export const isBusy = (state: State): boolean => state.turn.kind !== "idle";

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
import { RequestError } from "../api/client";
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
  /** Puts text in the composer for the user to finish. */
  seedComposer: (text: string) => void;
  seedUsed: () => void;
  clearNotice: () => void;
}

const Context = createContext<{ state: State; actions: Actions } | null>(null);

export function ExpensoProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const busy = useRef(false);
  const lastAttempt = useRef<Attempt | null>(null);

  const boot = useCallback(() => {
    api
      .openSession()
      .then((bootstrap) => dispatch({ type: "booted", bootstrap }))
      .catch(() => dispatch({ type: "boot_failed" }));
  }, []);

  useEffect(boot, [boot]);

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
      seedComposer: (text) => dispatch({ type: "seed", text }),
      seedUsed: () => dispatch({ type: "seed_used" }),
      clearNotice: () => dispatch({ type: "notice_cleared" }),
    };
  }, [boot, run]);

  const value = useMemo(() => ({ state, actions }), [state, actions]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useExpenso() {
  const value = useContext(Context);
  if (!value) throw new Error("useExpenso must be used inside ExpensoProvider");
  return value;
}

export const isBusy = (state: State): boolean => state.turn.kind !== "idle";

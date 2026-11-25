import type {
  AccountDto,
  Bootstrap,
  ChatMessageDto,
  DeskState,
  ExpenseDto,
  LinkPreviewDto,
  TurnResult,
} from "../../../shared/contract";
import type { LinkCredential } from "../api/client";
import { type SlipField, changedFields } from "../lib/diff";

/** What the app is doing right now. One thing at a time. */
export type Turn =
  | { kind: "idle" }
  | {
      kind: "sending" | "reading_receipt" | "confirming" | "cancelling" | "answering";
      startedAt: number;
    };

/** The user's message, shown at once while the server works on it. */
export interface Outgoing {
  text: string;
  /** Object URL of the photo being sent, if this is a receipt. */
  receiptPreview?: string;
}

/** Continuing from Telegram: checking a link or code, asking to confirm, connecting, or explaining why not. */
export interface LinkFlow {
  credential: LinkCredential;
  stage: "checking" | "ready" | "connecting" | "error";
  preview?: LinkPreviewDto;
  error?: string;
}

export interface State {
  status: "booting" | "ready" | "boot_failed";
  /** Who this browser is: a guest, or connected to a Telegram account. */
  account: AccountDto | null;
  /** A handoff from Telegram in progress, if any. */
  link: LinkFlow | null;
  /** The conversation, exactly as the server stored it. */
  messages: ChatMessageDto[];
  /** The desk as of the last server response. Never computed in the browser. */
  desk: DeskState | null;
  turn: Turn;
  outgoing: Outgoing | null;
  /** A request that got no answer at all. The user can retry it. */
  failed: { message: string } | null;
  /** Something the server refused without storing it, e.g. a file that is not an image. */
  notice: string | null;
  /** Slip fields that changed in the last turn, for a brief highlight. */
  highlight: { fields: SlipField[]; key: number };
  /** The slip that was just submitted; stays on the desk, stamped, until the next one. */
  filed: ExpenseDto | null;
  /** Receipt photos from this visit, by message id. They are never stored anywhere else. */
  receiptPreviews: Record<number, string>;
  /** The photo behind the slip currently on the desk, if it was sent during this visit. */
  slipPreview: string | null;
  /** Text to put in the composer (when the user taps a field or an example). */
  seed: { text: string; key: number } | null;
  /** Bumps whenever the set of filed expenses may have changed. */
  ledgerVersion: number;
}

export const initialState: State = {
  status: "booting",
  account: null,
  link: null,
  messages: [],
  desk: null,
  turn: { kind: "idle" },
  outgoing: null,
  failed: null,
  notice: null,
  highlight: { fields: [], key: 0 },
  filed: null,
  receiptPreviews: {},
  slipPreview: null,
  seed: null,
  ledgerVersion: 0,
};

export type Action =
  | { type: "booted"; bootstrap: Bootstrap }
  | { type: "boot_failed" }
  /** The browser now opens a different workspace (connected to Telegram, or disconnected). */
  | { type: "workspace_replaced"; bootstrap: Bootstrap }
  /** Fresh server state while idle: something may have changed in Telegram. */
  | { type: "refreshed"; bootstrap: Bootstrap }
  | { type: "link_started"; credential: LinkCredential }
  | { type: "link_previewed"; preview: LinkPreviewDto }
  | { type: "link_connecting" }
  | { type: "link_failed"; message: string }
  | { type: "link_closed" }
  /** The user started a new conversation; `bootstrap` is the server's state afterwards. */
  | { type: "conversation_reset"; bootstrap: Bootstrap }
  | { type: "turn_started"; turn: Exclude<Turn, { kind: "idle" }>; outgoing?: Outgoing }
  | { type: "turn_finished"; result: TurnResult }
  /** The server answered with a refusal (bad input, file too large…). */
  | { type: "turn_rejected"; message: string }
  /** No answer arrived. `bootstrap` is the conversation re-read from the server afterwards. */
  | { type: "turn_lost"; bootstrap: Bootstrap | null; message: string }
  | { type: "notice_cleared" }
  | { type: "seed"; text: string }
  | { type: "seed_used" };

const lastId = (messages: ChatMessageDto[]): number => messages.at(-1)?.id ?? 0;

function submittedIn(messages: ChatMessageDto[]): ExpenseDto | null {
  for (const message of messages) {
    const card = message.card;
    if (card?.kind === "expense" && card.event === "submitted") return card.expense;
  }
  return null;
}

/** The desk has nothing in progress: no draft and no half-read receipt. */
const deskIsClear = (desk: DeskState): boolean => !desk.currentSlip && !desk.pendingReceipt;

export function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "booted":
      return {
        ...state,
        status: "ready",
        messages: action.bootstrap.messages,
        desk: action.bootstrap.desk,
        account: action.bootstrap.account,
      };

    case "workspace_replaced":
      // Everything on screen belonged to the workspace that was left.
      return {
        ...state,
        status: "ready",
        messages: action.bootstrap.messages,
        desk: action.bootstrap.desk,
        account: action.bootstrap.account,
        outgoing: null,
        failed: null,
        notice: null,
        filed: null,
        receiptPreviews: {},
        slipPreview: null,
        highlight: { fields: [], key: state.highlight.key },
        ledgerVersion: state.ledgerVersion + 1,
      };

    case "refreshed": {
      // Never under a turn in progress: that turn's answer is the newer truth.
      if (state.turn.kind !== "idle" || !state.desk) return state;
      const { bootstrap } = action;
      const signedOut = state.account?.kind === "telegram" && bootstrap.account.kind === "guest";
      if (signedOut) {
        return {
          ...reducer(state, { type: "workspace_replaced", bootstrap }),
          notice: "This browser was signed out from Telegram. Send /web to Expenso to continue here again.",
        };
      }
      const unchanged =
        lastId(bootstrap.messages) === lastId(state.messages) &&
        bootstrap.messages.length === state.messages.length &&
        JSON.stringify(bootstrap.desk) === JSON.stringify(state.desk);
      if (unchanged) return state;
      const fields = changedFields(state.desk.currentSlip, bootstrap.desk.currentSlip);
      const clear = deskIsClear(bootstrap.desk);
      return {
        ...state,
        messages: bootstrap.messages,
        desk: bootstrap.desk,
        account: bootstrap.account,
        highlight: fields.length > 0 ? { fields, key: state.highlight.key + 1 } : state.highlight,
        // A slip that left the desk elsewhere (submitted or discarded in Telegram) takes its photo along.
        slipPreview: clear ? null : state.slipPreview,
        filed: clear ? state.filed : null,
        ledgerVersion: state.ledgerVersion + 1,
      };
    }

    case "link_started":
      return { ...state, link: { credential: action.credential, stage: "checking" } };

    case "link_previewed":
      return state.link ? { ...state, link: { ...state.link, stage: "ready", preview: action.preview } } : state;

    case "link_connecting":
      return state.link ? { ...state, link: { ...state.link, stage: "connecting" } } : state;

    case "link_failed":
      return state.link ? { ...state, link: { ...state.link, stage: "error", error: action.message } } : state;

    case "link_closed":
      return { ...state, link: null };

    case "boot_failed":
      return { ...state, status: "boot_failed" };

    case "conversation_reset":
      // Only the talk goes. Whatever is on the desk is the server's to say.
      return {
        ...state,
        messages: action.bootstrap.messages,
        desk: action.bootstrap.desk,
        outgoing: null,
        failed: null,
        notice: null,
        receiptPreviews: {},
      };

    case "turn_started":
      return {
        ...state,
        turn: action.turn,
        outgoing: action.outgoing ?? null,
        failed: null,
        notice: null,
        // A new photo replaces whatever was on the desk.
        slipPreview: action.outgoing?.receiptPreview ?? state.slipPreview,
        filed: action.turn.kind === "reading_receipt" ? null : state.filed,
      };

    case "turn_finished": {
      const { result } = action;
      const known = new Set(state.messages.map((m) => m.id));
      const added = result.messages.filter((m) => !known.has(m.id));

      const receiptPreviews = { ...state.receiptPreviews };
      const photo = added.find((m) => m.role === "user" && m.attachment);
      if (photo && state.outgoing?.receiptPreview) {
        receiptPreviews[photo.id] = state.outgoing.receiptPreview;
      }

      const justFiled = submittedIn(added);
      const clear = deskIsClear(result.desk);
      const filed = clear ? (justFiled ?? state.filed) : null;
      // Something new appeared on a desk that had nothing in progress, and it
      // did not come from a photo: the old photo has nothing to do with it.
      const startedFresh =
        state.turn.kind !== "reading_receipt" && !!state.desk && deskIsClear(state.desk) && !clear;
      const fields = changedFields(state.desk?.currentSlip ?? null, result.desk.currentSlip);

      return {
        ...state,
        messages: [...state.messages, ...added],
        desk: result.desk,
        turn: { kind: "idle" },
        outgoing: null,
        failed: null,
        notice: result.notice?.message ?? null,
        highlight: fields.length > 0 ? { fields, key: state.highlight.key + 1 } : state.highlight,
        filed,
        receiptPreviews,
        // Keep the photo while it still belongs to something on the desk.
        slipPreview: startedFresh || (clear && !filed) ? null : state.slipPreview,
        ledgerVersion: state.ledgerVersion + 1,
      };
    }

    case "turn_rejected":
      return { ...state, turn: { kind: "idle" }, outgoing: null, notice: action.message };

    case "turn_lost": {
      // The request may or may not have reached the server. If re-reading the
      // conversation shows new messages, it did, and there is nothing to retry.
      const arrived = action.bootstrap !== null && lastId(action.bootstrap.messages) > lastId(state.messages);
      return {
        ...state,
        messages: action.bootstrap?.messages ?? state.messages,
        desk: action.bootstrap?.desk ?? state.desk,
        account: action.bootstrap?.account ?? state.account,
        turn: { kind: "idle" },
        outgoing: arrived ? null : state.outgoing,
        failed: arrived ? null : { message: action.message },
        ledgerVersion: state.ledgerVersion + 1,
      };
    }

    case "notice_cleared":
      return { ...state, notice: null };

    case "seed":
      return { ...state, seed: { text: action.text, key: (state.seed?.key ?? 0) + 1 } };

    case "seed_used":
      return { ...state, seed: null };
  }
}

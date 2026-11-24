import type { Bootstrap, ChatMessageDto, DeskState, ExpenseDto, TurnResult } from "../../../shared/contract";
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

export interface State {
  status: "booting" | "ready" | "boot_failed";
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
      };

    case "boot_failed":
      return { ...state, status: "boot_failed" };

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

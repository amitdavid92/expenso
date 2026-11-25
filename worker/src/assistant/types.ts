import type {
  Category,
  FieldChange,
  PolicyVerdictDto,
  ReceiptAnalysisDto,
  SpendingSummaryDto,
} from "../../../shared/contract";
import type { LlmClient } from "../llm/types";
import type { Expense } from "../services/expenses";

export interface AssistantConfig {
  /** Model requests one user may cause per day. */
  userDailyLimit: number;
  /** Model requests the whole application may make per day. */
  appDailyLimit: number;
  /** Model requests the whole application may make in any 60 seconds. */
  appPerMinuteLimit: number;
  /** Hard cap on model requests for a single user message (retries included). */
  maxRounds: number;
  /** Longest a single model request may take. */
  requestTimeoutMs: number;
  /**
   * The same, for reading a receipt photo. An image takes the model several
   * seconds longer than a line of text, and there is only one request per
   * receipt, so it is allowed most of the turn's deadline.
   */
  receiptRequestTimeoutMs: number;
  /** Longest a whole user message may take, across all model requests. */
  deadlineMs: number;
  /**
   * How long to pause before each retry of a failed request that is worth
   * retrying (network error, HTTP 5xx, hang). Its length is the number of retries.
   */
  retryDelaysMs: number[];
}

export interface AssistantDeps {
  db: D1Database;
  llm: LlmClient;
  config: AssistantConfig;
  /** The current time; replaceable in tests. */
  now?: () => Date;
}

/** Everything that can go wrong while talking to the model. */
export type TurnErrorCode =
  | "user_limit"
  | "app_limit"
  | "busy"
  | "provider_rate_limited"
  | "timeout"
  | "unavailable"
  | "too_many_steps";

export type AssistantErrorCode =
  | TurnErrorCode
  | "invalid_input"
  | "invalid_image"
  | "image_too_large"
  | "extraction_failed";

/** What was read from a receipt, validated. Same shape on every channel. */
export type ReceiptAnalysis = ReceiptAnalysisDto;

/**
 * A card as it is stored with a message. An expense is referenced by id, not
 * copied: whoever shows the card looks up the expense's current state, so an
 * old card can truthfully say "replaced" or "submitted".
 */
export type StoredCard =
  | {
      kind: "expense";
      event: "drafted" | "updated" | "submitted" | "cancelled";
      expenseId: number;
      changes?: FieldChange[];
    }
  | { kind: "receipt"; analysis: ReceiptAnalysis; expenseId?: number }
  | {
      kind: "policy_check";
      category: Category;
      amountCents: number;
      limitCents: number;
      verdict: PolicyVerdictDto;
    }
  | { kind: "summary"; summary: SpendingSummaryDto; from?: string; to?: string };

/** Structured data stored next to a message's text (the `meta` column). */
export interface MessageMeta {
  /**
   * The assistant's own sentence, without the notices that code appends for
   * text-only channels. A channel that shows the card shows this instead of
   * the full text.
   */
  lead?: string;
  /** On a user message: a receipt photo was sent. The image is not stored. */
  attachment?: "receipt_photo";
  card?: StoredCard;
  error?: AssistantErrorCode;
}

export interface AssistantReply {
  /** Text to show the user. Always present, also when something failed. */
  reply: string;
  /** The user's draft after this turn, read from the database (for Confirm/Cancel buttons). */
  pendingExpense: Expense | null;
  /** Set when the turn failed; `reply` then holds a friendly explanation. */
  error?: AssistantErrorCode;
  /** Set when the turn analysed a receipt photo: what was read, in structured form. */
  receipt?: ReceiptAnalysis;
}

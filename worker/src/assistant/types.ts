import type { LlmClient } from "../llm/types";
import type { Expense } from "../services/expenses";
import type { ReceiptAnalysis } from "./receipts";

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

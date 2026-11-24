/**
 * The contract between the Worker's web API and the browser app. Both sides
 * import these types, so a change here is checked on both by the compiler.
 *
 * Money is always integer cents. Dates are YYYY-MM-DD; timestamps are ISO 8601.
 */

export const CATEGORIES = ["meals", "travel", "lodging", "software", "office", "other"] as const;
export type Category = (typeof CATEGORIES)[number];

export type ExpenseStatus = "draft" | "submitted" | "cancelled";
export type PolicyResult = "within_policy" | "needs_review";

export interface ExpenseDto {
  id: number;
  amountCents: number;
  category: Category;
  merchant: string;
  expenseDate: string;
  description: string | null;
  /** draft → submitted | cancelled. "submitted" is not "approved". */
  status: ExpenseStatus;
  /** Whether it complied with policy; independent of `status`. */
  policyResult: PolicyResult;
  policyNotes: string | null;
  createdAt: string;
  submittedAt: string | null;
}

export type PolicyVerdictDto =
  | { outcome: "within_policy" }
  | { outcome: "needs_review"; notes: string[] }
  | { outcome: "blocked"; reasons: string[] };

export interface SpendingSummaryDto {
  totalCents: number;
  count: number;
  needsReviewCount: number;
  byCategory: { category: Category; totalCents: number; count: number }[];
}

export type ReceiptField = "merchant" | "amount" | "currency" | "date" | "category";

export interface ReceiptFieldsDto {
  merchant: string | null;
  /** The printed total in minor units of `currency`. */
  amountCents: number | null;
  /** ISO 4217 code, e.g. "USD". */
  currency: string | null;
  expenseDate: string | null;
  category: Category | null;
  description: string | null;
}

export interface ReceiptAnalysisDto {
  status:
    | "draft_created"
    /** Some required fields could not be read; see `missing`. */
    | "needs_details"
    | "unsupported_currency"
    /** Policy forbids this expense; see `reasons`. */
    | "blocked_by_policy"
    | "not_a_receipt"
    /** Too blurry, dark or cropped to read. */
    | "unreadable";
  /** Validated values. Null means missing, unreadable or invalid; never a guess. */
  fields: ReceiptFieldsDto;
  /** Required fields still needed before a draft can exist. */
  missing: ReceiptField[];
  reasons: string[];
  /**
   * Set when the receipt showed only a symbol such as "$": the currency it most
   * likely means. It is a question to put to the user, not a value to use.
   */
  suggestedCurrency?: string | null;
}

export interface FieldChange {
  field: "amount" | "category" | "merchant" | "date" | "description";
  from: string;
  to: string;
}

/** Structured content attached to an assistant message. Chosen by code, never written by the model. */
export type Card =
  | {
      kind: "expense";
      event: "drafted" | "updated" | "submitted" | "cancelled";
      /** The expense as it is now, which may be later than the event. */
      expense: ExpenseDto;
      changes?: FieldChange[];
    }
  | { kind: "receipt"; analysis: ReceiptAnalysisDto; expense?: ExpenseDto }
  | {
      kind: "policy_check";
      category: Category;
      amountCents: number;
      limitCents: number;
      verdict: PolicyVerdictDto;
    }
  | { kind: "summary"; summary: SpendingSummaryDto; from?: string; to?: string };

export type ErrorCode =
  | "user_limit"
  | "app_limit"
  | "busy"
  | "provider_rate_limited"
  | "timeout"
  | "unavailable"
  | "too_many_steps"
  | "invalid_input"
  | "invalid_image"
  | "image_too_large"
  | "extraction_failed";

export interface ChatMessageDto {
  id: number;
  role: "user" | "assistant";
  text: string;
  createdAt: string;
  /** The user sent a receipt photo. The image itself is never stored. */
  attachment?: "receipt_photo";
  card?: Card;
  error?: { code: ErrorCode; retryable: boolean };
}

/** Everything shown beside the conversation. All of it is read from the database. */
export interface DeskState {
  /** The user's one active draft, if any. */
  currentSlip: ExpenseDto | null;
  /** A receipt that was read only in part and is waiting for details. */
  pendingReceipt: ReceiptAnalysisDto | null;
  /** Submitted expenses dated in the current calendar month (UTC). */
  month: { from: string; to: string; summary: SpendingSummaryDto };
  /** Most recent submitted expenses, newest first. */
  recent: ExpenseDto[];
}

export interface Bootstrap {
  messages: ChatMessageDto[];
  desk: DeskState;
}

export interface TurnResult {
  /** Messages stored during this turn, oldest first. */
  messages: ChatMessageDto[];
  desk: DeskState;
  /** A problem that was not stored in the conversation, e.g. a file that was refused. */
  notice?: { code: ErrorCode; message: string };
}

export interface PolicyDto {
  currency: string;
  maxAgeDays: number;
  limits: { category: Category; limitCents: number }[];
  rules: string[];
}

export interface PolicyCheckDto {
  category: Category;
  amountCents: number;
  limitCents: number;
  verdict: PolicyVerdictDto;
}

export interface ApiError {
  error: { code: string; message: string };
}

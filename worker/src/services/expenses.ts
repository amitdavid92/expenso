import { isIsoDate, utcDay } from "../lib/dates";
import { ValidationError, assertPositiveInt } from "../lib/errors";
import { CATEGORIES, type Category, POLICY, evaluateExpense } from "./policy";

/**
 * Expense lifecycle:   draft ──confirm──▶ submitted
 *                        └────cancel / replaced──▶ cancelled
 *
 * "submitted" means sent for review. Whether it complied with policy is a
 * separate fact, stored in `policyResult`. Nothing here approves reimbursement.
 *
 * Every query filters by user id, so one user can never read or change
 * another user's expenses.
 */

export const STATUSES = ["draft", "submitted", "cancelled"] as const;
export type ExpenseStatus = (typeof STATUSES)[number];
export type PolicyResult = "within_policy" | "needs_review";

/** A sanity cap ($100,000), not a policy rule: anything above is treated as a typo. */
export const MAX_AMOUNT_CENTS = 100_000_00;
const MAX_MERCHANT_LENGTH = 100;
const MAX_DESCRIPTION_LENGTH = 500;
const DEFAULT_LIST_LIMIT = 20;
const MAX_LIST_LIMIT = 50;

export interface Expense {
  id: number;
  amountCents: number;
  category: Category;
  merchant: string;
  /** YYYY-MM-DD */
  expenseDate: string;
  description: string | null;
  status: ExpenseStatus;
  policyResult: PolicyResult;
  policyNotes: string | null;
  createdAt: string;
  submittedAt: string | null;
}

interface ExpenseRow {
  id: number;
  amount_cents: number;
  category: Category;
  merchant: string;
  expense_date: string;
  description: string | null;
  status: ExpenseStatus;
  policy_result: PolicyResult;
  policy_notes: string | null;
  created_at: string;
  submitted_at: string | null;
}

const COLUMNS =
  "id, amount_cents, category, merchant, expense_date, description, status, policy_result, policy_notes, created_at, submitted_at";

function toExpense(row: ExpenseRow): Expense {
  return {
    id: row.id,
    amountCents: row.amount_cents,
    category: row.category,
    merchant: row.merchant,
    expenseDate: row.expense_date,
    description: row.description,
    status: row.status,
    policyResult: row.policy_result,
    policyNotes: row.policy_notes,
    createdAt: row.created_at,
    submittedAt: row.submitted_at,
  };
}

// ── Creating a draft ────────────────────────────────────────────────────────

export interface DraftInput {
  amountCents: number;
  category: Category;
  merchant: string;
  /** YYYY-MM-DD */
  expenseDate: string;
  description?: string | null;
  /** Optional; only USD is accepted. */
  currency?: string;
}

export type DraftResult =
  | { outcome: "drafted"; expense: Expense }
  /** Policy forbids this expense; nothing was stored. */
  | { outcome: "blocked"; reasons: string[] };

interface ValidDraft {
  amountCents: number;
  category: Category;
  merchant: string;
  expenseDate: string;
  description: string | null;
}

function validateDraft(input: DraftInput): ValidDraft {
  const issues: string[] = [];
  const { amountCents, category, merchant, expenseDate, description, currency } = input;

  if (currency !== undefined && String(currency).toUpperCase() !== POLICY.currency) {
    issues.push(`Only ${POLICY.currency} expenses are supported.`);
  }
  if (typeof amountCents !== "number" || !Number.isSafeInteger(amountCents) || amountCents <= 0) {
    issues.push("Amount must be a positive whole number of cents.");
  } else if (amountCents > MAX_AMOUNT_CENTS) {
    issues.push("Amount is too large to be a single expense.");
  }
  if (!CATEGORIES.includes(category)) {
    issues.push(`Category must be one of: ${CATEGORIES.join(", ")}.`);
  }
  if (typeof merchant !== "string" || merchant.trim() === "") {
    issues.push("Merchant is required.");
  } else if (merchant.trim().length > MAX_MERCHANT_LENGTH) {
    issues.push(`Merchant cannot be longer than ${MAX_MERCHANT_LENGTH} characters.`);
  }
  if (!isIsoDate(expenseDate)) {
    issues.push("Date must be a real calendar date in YYYY-MM-DD format.");
  }
  if (description != null) {
    if (typeof description !== "string") {
      issues.push("Description must be text.");
    } else if (description.trim().length > MAX_DESCRIPTION_LENGTH) {
      issues.push(`Description cannot be longer than ${MAX_DESCRIPTION_LENGTH} characters.`);
    }
  }

  if (issues.length > 0) throw new ValidationError(issues);

  return {
    amountCents,
    category,
    merchant: merchant.trim(),
    expenseDate,
    description: description?.trim() || null,
  };
}

/**
 * Validates the input, applies company policy and stores the result as the
 * user's draft. Nothing is submitted here.
 *
 * A user has at most one draft. If one already exists it is cancelled and the
 * new one inserted in a single transaction (`db.batch`), so the old draft's id
 * stops working the moment the new one exists. The unique index
 * `idx_one_draft_per_user` backs this up at the database level.
 */
export async function createDraft(
  db: D1Database,
  userId: number,
  input: DraftInput,
  now: Date = new Date(),
): Promise<DraftResult> {
  assertPositiveInt(userId, "User id");
  const draft = validateDraft(input);

  const verdict = evaluateExpense(draft, utcDay(now));
  if (verdict.outcome === "blocked") {
    return { outcome: "blocked", reasons: verdict.reasons };
  }
  const policyNotes = verdict.outcome === "needs_review" ? verdict.notes.join(" ") : null;

  const [, inserted] = await db.batch<ExpenseRow>([
    db
      .prepare("UPDATE expenses SET status = 'cancelled' WHERE user_id = ? AND status = 'draft'")
      .bind(userId),
    db
      .prepare(
        `INSERT INTO expenses
           (user_id, amount_cents, category, merchant, expense_date, description, status, policy_result, policy_notes)
         VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, ?)
         RETURNING ${COLUMNS}`,
      )
      .bind(
        userId,
        draft.amountCents,
        draft.category,
        draft.merchant,
        draft.expenseDate,
        draft.description,
        verdict.outcome,
        policyNotes,
      ),
  ]);

  return { outcome: "drafted", expense: toExpense(inserted!.results[0]!) };
}

export async function getActiveDraft(db: D1Database, userId: number): Promise<Expense | null> {
  assertPositiveInt(userId, "User id");
  const row = await db
    .prepare(`SELECT ${COLUMNS} FROM expenses WHERE user_id = ? AND status = 'draft'`)
    .bind(userId)
    .first<ExpenseRow>();
  return row ? toExpense(row) : null;
}

// ── Confirming and cancelling ───────────────────────────────────────────────

export type ConfirmResult =
  | { outcome: "submitted"; expense: Expense }
  /** A repeat of an earlier confirmation; nothing changed. */
  | { outcome: "already_submitted"; expense: Expense }
  /** The draft was cancelled or replaced by a newer one. */
  | { outcome: "not_active" }
  /** No such expense for this user (also the answer for someone else's expense). */
  | { outcome: "not_found" };

export type CancelResult =
  | { outcome: "cancelled"; expense: Expense }
  | { outcome: "already_cancelled"; expense: Expense }
  /** Too late: submitted expenses cannot be cancelled. */
  | { outcome: "already_submitted"; expense: Expense }
  | { outcome: "not_found" };

function findOwned(db: D1Database, userId: number, expenseId: number) {
  return db
    .prepare(`SELECT ${COLUMNS} FROM expenses WHERE id = ? AND user_id = ?`)
    .bind(expenseId, userId)
    .first<ExpenseRow>();
}

/**
 * Submits one specific draft.
 *
 * The UPDATE only matches a row with this id, owned by this user, that is still
 * a draft. Those three checks and the state change happen in one statement, so
 * of any number of simultaneous confirmations exactly one sees "submitted".
 * Everything else is answered by reading the row afterwards.
 */
export async function confirmExpense(
  db: D1Database,
  userId: number,
  expenseId: number,
  now: Date = new Date(),
): Promise<ConfirmResult> {
  assertPositiveInt(userId, "User id");
  assertPositiveInt(expenseId, "Expense id");

  const updated = await db
    .prepare(
      `UPDATE expenses SET status = 'submitted', submitted_at = ?
       WHERE id = ? AND user_id = ? AND status = 'draft'
       RETURNING ${COLUMNS}`,
    )
    .bind(now.toISOString(), expenseId, userId)
    .first<ExpenseRow>();
  if (updated) return { outcome: "submitted", expense: toExpense(updated) };

  const existing = await findOwned(db, userId, expenseId);
  if (!existing) return { outcome: "not_found" };
  if (existing.status === "submitted") {
    return { outcome: "already_submitted", expense: toExpense(existing) };
  }
  return { outcome: "not_active" };
}

/** Discards one specific draft. Same atomic pattern as `confirmExpense`. */
export async function cancelDraft(
  db: D1Database,
  userId: number,
  expenseId: number,
): Promise<CancelResult> {
  assertPositiveInt(userId, "User id");
  assertPositiveInt(expenseId, "Expense id");

  const updated = await db
    .prepare(
      `UPDATE expenses SET status = 'cancelled'
       WHERE id = ? AND user_id = ? AND status = 'draft'
       RETURNING ${COLUMNS}`,
    )
    .bind(expenseId, userId)
    .first<ExpenseRow>();
  if (updated) return { outcome: "cancelled", expense: toExpense(updated) };

  const existing = await findOwned(db, userId, expenseId);
  if (!existing) return { outcome: "not_found" };
  if (existing.status === "submitted") {
    return { outcome: "already_submitted", expense: toExpense(existing) };
  }
  return { outcome: "already_cancelled", expense: toExpense(existing) };
}

// ── Reading ─────────────────────────────────────────────────────────────────

export interface DateRange {
  /** Inclusive, YYYY-MM-DD */
  from?: string;
  /** Inclusive, YYYY-MM-DD */
  to?: string;
}

export interface ExpenseFilters extends DateRange {
  /** Defaults to "submitted". */
  status?: ExpenseStatus;
  category?: Category;
  limit?: number;
}

function validateRange({ from, to }: DateRange): void {
  const issues: string[] = [];
  if (from !== undefined && !isIsoDate(from)) issues.push("From date must be YYYY-MM-DD.");
  if (to !== undefined && !isIsoDate(to)) issues.push("To date must be YYYY-MM-DD.");
  if (issues.length === 0 && from !== undefined && to !== undefined && from > to) {
    issues.push("From date cannot be after to date.");
  }
  if (issues.length > 0) throw new ValidationError(issues);
}

/** Adds the optional date conditions shared by the list and the summary. */
function rangeClause(range: DateRange, params: unknown[]): string {
  let sql = "";
  if (range.from !== undefined) {
    sql += " AND expense_date >= ?";
    params.push(range.from);
  }
  if (range.to !== undefined) {
    sql += " AND expense_date <= ?";
    params.push(range.to);
  }
  return sql;
}

/** The user's expenses, most recent expense date first. */
export async function listExpenses(
  db: D1Database,
  userId: number,
  filters: ExpenseFilters = {},
): Promise<Expense[]> {
  assertPositiveInt(userId, "User id");
  const { status = "submitted", category, limit = DEFAULT_LIST_LIMIT } = filters;

  if (!STATUSES.includes(status)) {
    throw new ValidationError(`Status must be one of: ${STATUSES.join(", ")}.`);
  }
  if (category !== undefined && !CATEGORIES.includes(category)) {
    throw new ValidationError(`Category must be one of: ${CATEGORIES.join(", ")}.`);
  }
  assertPositiveInt(limit, "Limit");
  if (limit > MAX_LIST_LIMIT) {
    throw new ValidationError(`Limit cannot be more than ${MAX_LIST_LIMIT}.`);
  }
  validateRange(filters);

  const params: unknown[] = [userId, status];
  let sql = `SELECT ${COLUMNS} FROM expenses WHERE user_id = ? AND status = ?`;
  if (category !== undefined) {
    sql += " AND category = ?";
    params.push(category);
  }
  sql += rangeClause(filters, params);
  sql += " ORDER BY expense_date DESC, id DESC LIMIT ?";
  params.push(limit);

  const { results } = await db
    .prepare(sql)
    .bind(...params)
    .all<ExpenseRow>();
  return results.map(toExpense);
}

export interface SpendingSummary {
  totalCents: number;
  count: number;
  /** How many of the counted expenses are waiting for manual review. */
  needsReviewCount: number;
  /** Largest total first. */
  byCategory: { category: Category; totalCents: number; count: number }[];
}

/** Totals of the user's submitted expenses. Sums are done in SQL on integer cents. */
export async function getSpendingSummary(
  db: D1Database,
  userId: number,
  range: DateRange = {},
): Promise<SpendingSummary> {
  assertPositiveInt(userId, "User id");
  validateRange(range);

  const params: unknown[] = [userId];
  const sql = `SELECT category,
                      SUM(amount_cents) AS total_cents,
                      COUNT(*) AS count,
                      SUM(policy_result = 'needs_review') AS needs_review
               FROM expenses
               WHERE user_id = ? AND status = 'submitted'${rangeClause(range, params)}
               GROUP BY category
               ORDER BY total_cents DESC, category`;

  const { results } = await db
    .prepare(sql)
    .bind(...params)
    .all<{ category: Category; total_cents: number; count: number; needs_review: number }>();

  return {
    totalCents: results.reduce((sum, r) => sum + r.total_cents, 0),
    count: results.reduce((sum, r) => sum + r.count, 0),
    needsReviewCount: results.reduce((sum, r) => sum + r.needs_review, 0),
    byCategory: results.map((r) => ({
      category: r.category,
      totalCents: r.total_cents,
      count: r.count,
    })),
  };
}

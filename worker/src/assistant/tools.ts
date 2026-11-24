import { ValidationError } from "../lib/errors";
import { formatCents, toCents } from "../lib/money";
import {
  type Expense,
  STATUSES,
  cancelDraft,
  createDraft,
  getActiveDraft,
  getSpendingSummary,
  listExpenses,
} from "../services/expenses";
import { CATEGORIES, type Category, POLICY } from "../services/policy";
import type { ToolCall, ToolDeclaration } from "../llm/types";

/**
 * The only things the model can do. Each tool is a thin wrapper over a
 * deterministic service:
 *
 * - arguments from the model are untrusted and validated here and in the service;
 * - the user id is never an argument, it comes from the authenticated context;
 * - there is deliberately no tool that submits an expense.
 */

export interface ToolContext {
  db: D1Database;
  /** The authenticated user. Set by the backend, never by the model. */
  userId: number;
  now: Date;
}

export interface ToolOutcome {
  /** Sent back to the model. */
  result: Record<string, unknown>;
  /** True when the user's draft was created, replaced or cancelled. */
  draftChanged?: boolean;
}

const isoDate = { type: "string", description: "Calendar date as YYYY-MM-DD." };
const category = { type: "string", enum: [...CATEGORIES] };

export const TOOL_DECLARATIONS: ToolDeclaration[] = [
  {
    name: "get_policy",
    description:
      "Look up the company expense policy: per-expense limits by category, the currency, and how old an expense may be. Use it for any question about what is allowed.",
    parameters: {
      type: "object",
      properties: { category: { ...category, description: "Only return this category's limit." } },
    },
  },
  {
    name: "prepare_expense",
    description:
      "Save an expense as a DRAFT and check it against policy. Also use it to change the current draft: call it again with every field, changed or not, and it replaces the draft. This never submits anything; only the user can submit, by confirming. Call it only when the user has given the amount, the merchant and the date; never invent a value.",
    parameters: {
      type: "object",
      properties: {
        amount: { type: "number", description: "Amount in dollars, e.g. 42.5." },
        currency: {
          type: "string",
          description:
            'ISO code of the currency the user stated, e.g. "USD" or "EUR". Use "USD" when they wrote $ or named no currency.',
        },
        category,
        merchant: { type: "string", description: "Who was paid." },
        date: { ...isoDate, description: "Date of the expense as YYYY-MM-DD." },
        description: { type: "string", description: "Optional short note." },
      },
      required: ["amount", "currency", "category", "merchant", "date"],
    },
  },
  {
    name: "cancel_draft",
    description: "Discard the user's current draft expense. Use it when the user no longer wants to submit it.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "list_expenses",
    description: "List the user's own expenses, newest first. Without a status it lists submitted expenses.",
    parameters: {
      type: "object",
      properties: {
        status: { type: "string", enum: [...STATUSES] },
        category,
        from: { ...isoDate, description: "Earliest expense date, inclusive (YYYY-MM-DD)." },
        to: { ...isoDate, description: "Latest expense date, inclusive (YYYY-MM-DD)." },
        limit: { type: "integer", description: "How many to return (1-50, default 20)." },
      },
    },
  },
  {
    name: "get_spending_summary",
    description:
      "Totals of the user's submitted expenses, overall and by category, optionally within a date range. Use it for any question about how much they spent; never add amounts up yourself.",
    parameters: {
      type: "object",
      properties: {
        from: { ...isoDate, description: "Earliest expense date, inclusive (YYYY-MM-DD)." },
        to: { ...isoDate, description: "Latest expense date, inclusive (YYYY-MM-DD)." },
      },
    },
  },
];

type Args = Record<string, unknown>;

function invalid(issues: string[]): ToolOutcome {
  return { result: { status: "invalid_arguments", issues } };
}

function expenseView(expense: Expense) {
  return {
    amount: formatCents(expense.amountCents),
    category: expense.category,
    merchant: expense.merchant,
    date: expense.expenseDate,
    description: expense.description,
    status: expense.status,
    policy: expense.policyResult,
    policy_notes: expense.policyNotes,
    submitted_at: expense.submittedAt,
  };
}

function getPolicy(args: Args): ToolOutcome {
  const { category } = args;
  if (category !== undefined && !CATEGORIES.includes(category as Category)) {
    return invalid([`Category must be one of: ${CATEGORIES.join(", ")}.`]);
  }
  const categories = category === undefined ? CATEGORIES : [category as Category];
  return {
    result: {
      status: "ok",
      currency: POLICY.currency,
      max_expense_age_days: POLICY.maxAgeDays,
      per_expense_limits: Object.fromEntries(
        categories.map((c) => [c, formatCents(POLICY.limitsCents[c])]),
      ),
      rules: [
        `Only ${POLICY.currency} expenses can be submitted.`,
        "An expense over its category limit can still be submitted, but it goes to manual review.",
        `An expense dated in the future or more than ${POLICY.maxAgeDays} days ago cannot be submitted.`,
      ],
    },
  };
}

async function prepareExpense(ctx: ToolContext, args: Args): Promise<ToolOutcome> {
  const issues: string[] = [];

  // Currency is checked explicitly: an amount in another currency must never be
  // stored as if it were dollars.
  if (typeof args.currency !== "string" || args.currency.trim() === "") {
    issues.push("Currency is required.");
  } else if (args.currency.trim().toUpperCase() !== POLICY.currency) {
    issues.push(
      `Only ${POLICY.currency} is supported. Do not convert; ask the user for the amount in ${POLICY.currency}.`,
    );
  }

  let amountCents = 0;
  try {
    amountCents = toCents(args.amount);
  } catch (error) {
    if (!(error instanceof ValidationError)) throw error;
    issues.push(...error.issues);
  }
  if (issues.length > 0) return invalid(issues);

  const outcome = await createDraft(
    ctx.db,
    ctx.userId,
    {
      amountCents,
      category: args.category as Category,
      merchant: args.merchant as string,
      expenseDate: args.date as string,
      description: args.description as string | undefined,
    },
    ctx.now,
  );

  if (outcome.outcome === "blocked") {
    return { result: { status: "blocked_by_policy", draft_saved: false, reasons: outcome.reasons } };
  }
  return {
    draftChanged: true,
    result: {
      status: "draft_saved",
      submitted: false,
      draft: expenseView(outcome.expense),
      note: 'This is only a draft. The app shows the user the draft and how to confirm. It is submitted only if the user types "confirm"; you cannot submit it.',
    },
  };
}

async function cancelActiveDraft(ctx: ToolContext): Promise<ToolOutcome> {
  const draft = await getActiveDraft(ctx.db, ctx.userId);
  if (!draft) return { result: { status: "no_active_draft" } };
  const outcome = await cancelDraft(ctx.db, ctx.userId, draft.id);
  if (outcome.outcome === "cancelled" || outcome.outcome === "already_cancelled") {
    return { draftChanged: true, result: { status: "draft_cancelled" } };
  }
  // It was submitted (by the user) in the instant between the two statements.
  return { result: { status: "no_active_draft" } };
}

async function listUserExpenses(ctx: ToolContext, args: Args): Promise<ToolOutcome> {
  const expenses = await listExpenses(ctx.db, ctx.userId, {
    status: args.status as Expense["status"] | undefined,
    category: args.category as Category | undefined,
    from: args.from as string | undefined,
    to: args.to as string | undefined,
    limit: args.limit as number | undefined,
  });
  return { result: { status: "ok", count: expenses.length, expenses: expenses.map(expenseView) } };
}

async function spendingSummary(ctx: ToolContext, args: Args): Promise<ToolOutcome> {
  const range = { from: args.from as string | undefined, to: args.to as string | undefined };
  const summary = await getSpendingSummary(ctx.db, ctx.userId, range);
  return {
    result: {
      status: "ok",
      scope: "submitted expenses only",
      from: range.from ?? null,
      to: range.to ?? null,
      total: formatCents(summary.totalCents),
      count: summary.count,
      needs_review_count: summary.needsReviewCount,
      by_category: summary.byCategory.map((c) => ({
        category: c.category,
        total: formatCents(c.totalCents),
        count: c.count,
      })),
    },
  };
}

/**
 * Runs one tool call. It never throws for anything the model did wrong: bad
 * arguments and unknown tools come back as a result the model can read and
 * recover from. Arguments are not logged.
 */
export async function executeTool(ctx: ToolContext, call: ToolCall): Promise<ToolOutcome> {
  const { name, args } = call;
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    return invalid(["Arguments must be a JSON object."]);
  }
  const input = args as Args;

  try {
    switch (name) {
      case "get_policy":
        return getPolicy(input);
      case "prepare_expense":
        return await prepareExpense(ctx, input);
      case "cancel_draft":
        return await cancelActiveDraft(ctx);
      case "list_expenses":
        return await listUserExpenses(ctx, input);
      case "get_spending_summary":
        return await spendingSummary(ctx, input);
      default:
        return {
          result: {
            status: "unknown_tool",
            message: `There is no such tool. Available tools: ${TOOL_DECLARATIONS.map((t) => t.name).join(", ")}.`,
          },
        };
    }
  } catch (error) {
    if (error instanceof ValidationError) return invalid(error.issues);
    console.error(`tool_failed name=${name} error=${error instanceof Error ? error.name : "unknown"}`);
    return { result: { status: "error", message: "The action failed. Ask the user to try again." } };
  }
}

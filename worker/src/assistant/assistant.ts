import { type LlmClient, LlmError, type LlmMessage, type LlmResponse } from "../llm/types";
import { MAX_MESSAGE_LENGTH, appendMessage, listRecentMessages } from "../services/conversations";
import { type Expense, cancelDraft, confirmExpense, getActiveDraft } from "../services/expenses";
import { consumeQuota } from "../services/limits";
import { describeExpense, draftNotice, submittedNotice } from "./format";
import { buildSystemPrompt } from "./prompt";
import { TOOL_DECLARATIONS, executeTool } from "./tools";

/**
 * The assistant, independent of any channel. Web and Telegram adapters call
 * the three functions exported here and render what comes back.
 *
 *   handleMessage     a text message from the user
 *   confirmDraftById  the user pressed Confirm on a specific draft
 *   cancelDraftById   the user pressed Cancel on a specific draft
 *
 * The model can read data and prepare or discard a draft. Submitting is only
 * ever done by code in this file, in response to an explicit user action.
 */

export interface AssistantConfig {
  /** Model requests one user may cause per day. */
  userDailyLimit: number;
  /** Model requests the whole application may make per day. */
  appDailyLimit: number;
  /** Hard cap on model requests for a single user message (retries included). */
  maxRounds: number;
  /** Longest a single model request may take. */
  requestTimeoutMs: number;
  /** Longest a whole user message may take, across all model requests. */
  deadlineMs: number;
  /**
   * How long to pause before each retry of a failed request that is worth
   * retrying (network error, HTTP 5xx). Its length is the number of retries.
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

export type AssistantErrorCode =
  | "invalid_input"
  | "user_limit"
  | "app_limit"
  | "provider_rate_limited"
  | "timeout"
  | "unavailable"
  | "too_many_steps";

export interface AssistantReply {
  /** Text to show the user. Always present, also when something failed. */
  reply: string;
  /** The user's draft after this turn, read from the database (for Confirm/Cancel buttons). */
  pendingExpense: Expense | null;
  /** Set when the turn failed; `reply` then holds a friendly explanation. */
  error?: AssistantErrorCode;
}

const MAX_USER_MESSAGE_LENGTH = 2000;
const HISTORY_LIMIT = 20;

/** Everything that can go wrong once a message has been accepted. */
type TurnErrorCode = Exclude<AssistantErrorCode, "invalid_input">;

const ERROR_TEXT: Record<TurnErrorCode, string> = {
  user_limit:
    'You have reached your daily limit for assistant messages. It resets at midnight Pacific time. You can still type "confirm" or "cancel" for a pending draft.',
  app_limit:
    'The assistant has used up its free daily allowance. It resets at midnight Pacific time. You can still type "confirm" or "cancel" for a pending draft.',
  provider_rate_limited: "The AI service is busy right now. Please wait a minute and try again.",
  timeout: "That took too long, so I stopped. Please try again.",
  unavailable: "I couldn't reach the AI service just now. Please try again in a moment.",
  too_many_steps:
    "I couldn't finish that in a reasonable number of steps. Please try rephrasing it, or ask for one thing at a time.",
};

// ── Explicit confirm / cancel ───────────────────────────────────────────────

type Command = "confirm" | "cancel";

/**
 * Only an exact command counts. "yes" or "ok, confirm it" are ordinary
 * messages: they go to the model, which cannot submit anything.
 */
function parseCommand(text: string): Command | null {
  const word = text.trim().toLowerCase().replace(/^\//, "").replace(/[.!]+$/, "");
  return word === "confirm" || word === "cancel" ? word : null;
}

async function confirmText(deps: AssistantDeps, userId: number, expenseId: number): Promise<string> {
  const now = (deps.now ?? (() => new Date()))();
  const result = await confirmExpense(deps.db, userId, expenseId, now);
  switch (result.outcome) {
    case "submitted":
      return submittedNotice(result.expense);
    case "already_submitted":
      return `That expense was already submitted: ${describeExpense(result.expense)}`;
    case "blocked":
      return `This draft can no longer be submitted. ${result.reasons.join(" ")} Type "cancel" to discard it, or tell me the corrected details.`;
    case "not_active":
      return "That draft is no longer active. It was cancelled or replaced by a newer one.";
    case "not_found":
      return "I couldn't find that draft.";
  }
}

async function cancelText(deps: AssistantDeps, userId: number, expenseId: number): Promise<string> {
  const result = await cancelDraft(deps.db, userId, expenseId);
  switch (result.outcome) {
    case "cancelled":
    case "already_cancelled":
      return `Draft discarded: ${describeExpense(result.expense)}`;
    case "already_submitted":
      return `That expense was already submitted, so it can't be cancelled here: ${describeExpense(result.expense)}`;
    case "not_found":
      return "I couldn't find that draft.";
  }
}

/** Stores the assistant's words and returns the reply together with the current draft. */
async function finish(
  deps: AssistantDeps,
  userId: number,
  reply: string,
  error?: AssistantErrorCode,
): Promise<AssistantReply> {
  const text = reply.slice(0, MAX_MESSAGE_LENGTH);
  await appendMessage(deps.db, userId, "assistant", text);
  const pendingExpense = await getActiveDraft(deps.db, userId);
  return error ? { reply: text, pendingExpense, error } : { reply: text, pendingExpense };
}

/** The user pressed Confirm on one specific draft. No model involved. */
export async function confirmDraftById(
  deps: AssistantDeps,
  input: { userId: number; expenseId: number },
): Promise<AssistantReply> {
  return finish(deps, input.userId, await confirmText(deps, input.userId, input.expenseId));
}

/** The user pressed Cancel on one specific draft. No model involved. */
export async function cancelDraftById(
  deps: AssistantDeps,
  input: { userId: number; expenseId: number },
): Promise<AssistantReply> {
  return finish(deps, input.userId, await cancelText(deps, input.userId, input.expenseId));
}

async function runCommand(deps: AssistantDeps, userId: number, command: Command): Promise<string> {
  const draft = await getActiveDraft(deps.db, userId);
  if (!draft) return `There is no draft to ${command}.`;
  return command === "confirm"
    ? confirmText(deps, userId, draft.id)
    : cancelText(deps, userId, draft.id);
}

// ── Guard against false "submitted" claims ──────────────────────────────────

/** "I've submitted…": always false, the model has no way to submit. */
const FIRST_PERSON_CLAIM = /\bI(?:'ve|’ve| have)?(?: just| already| now)? (?:submitted|filed|sent in)\b/i;
/** "has been submitted": false on a turn whose only effect was saving a draft. */
const PASSIVE_CLAIM =
  /\b(?:has|have) been (?:successfully )?submitted\b|\bsuccessfully submitted\b|\b(?:is|was) (?:now )?submitted\b/i;

/**
 * The prompt tells the model not to claim a submission; this makes sure the
 * user never sees one anyway. A false claim is replaced with a true statement.
 */
function withoutFalseClaims(text: string, draftChanged: boolean, hasDraft: boolean): string {
  const falseClaim = FIRST_PERSON_CLAIM.test(text) || (draftChanged && PASSIVE_CLAIM.test(text));
  if (!falseClaim) return text;
  return hasDraft
    ? "I've saved that as a draft."
    : "I can't submit expenses myself. Give me the expense details and I'll prepare a draft for you to confirm.";
}

// ── The model loop ──────────────────────────────────────────────────────────

function errorCodeFor(error: unknown): TurnErrorCode {
  if (error instanceof LlmError) {
    if (error.kind === "rate_limited") return "provider_rate_limited";
    if (error.kind === "timeout") return "timeout";
  }
  return "unavailable";
}

/** Runs one model request and guarantees it ends by the timeout, even if the client hangs. */
async function generateWithTimeout(
  deps: AssistantDeps,
  system: string,
  messages: LlmMessage[],
  timeoutMs: number,
): Promise<LlmResponse> {
  const signal = AbortSignal.timeout(timeoutMs);
  const expired = new Promise<never>((_resolve, reject) => {
    // A request that hung has changed nothing on our side, so it may be retried.
    signal.addEventListener("abort", () => reject(new LlmError("timeout", { retryable: true })), {
      once: true,
    });
  });
  return Promise.race([
    deps.llm.generate({ system, messages, tools: TOOL_DECLARATIONS, signal }),
    expired,
  ]);
}

interface TurnResult {
  text: string;
  error?: TurnErrorCode;
  draftChanged: boolean;
}

async function runModelTurn(
  deps: AssistantDeps,
  userId: number,
  messages: LlmMessage[],
  now: Date,
): Promise<TurnResult> {
  const { config } = deps;
  const deadlineAt = Date.now() + config.deadlineMs;
  const system = buildSystemPrompt({ now, activeDraft: await getActiveDraft(deps.db, userId) });
  let draftChanged = false;
  let retries = 0;

  const fail = (error: TurnErrorCode): TurnResult => ({
    text: ERROR_TEXT[error],
    error,
    draftChanged,
  });

  for (let round = 1; round <= config.maxRounds; round++) {
    const remainingMs = deadlineAt - Date.now();
    if (remainingMs <= 0) return fail("timeout");

    // Quota is taken before every real request, including tool rounds and retries.
    const quota = await consumeQuota(deps.db, {
      userId,
      userDailyLimit: config.userDailyLimit,
      appDailyLimit: config.appDailyLimit,
      now,
    });
    if (!quota.allowed) return fail(quota.exhausted === "user" ? "user_limit" : "app_limit");

    let response: LlmResponse;
    try {
      response = await generateWithTimeout(
        deps,
        system,
        messages,
        Math.min(config.requestTimeoutMs, remainingMs),
      );
    } catch (error) {
      // Only the kind and HTTP status are logged: never message text, arguments or credentials.
      console.warn(
        error instanceof LlmError
          ? `llm_request_failed kind=${error.kind} status=${error.status ?? "none"}`
          : "llm_request_failed kind=unexpected",
      );
      const delayMs = config.retryDelaysMs[retries];
      if (
        error instanceof LlmError &&
        error.retryable &&
        delayMs !== undefined &&
        Date.now() + delayMs < deadlineAt
      ) {
        // Safe to repeat: tools run only after a successful response, so a
        // failed request has changed nothing. The pause lets a brief provider
        // spike ("model is experiencing high demand") pass.
        retries++;
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        continue;
      }
      return fail(errorCodeFor(error));
    }

    if (response.toolCalls.length === 0) {
      return { text: response.text, draftChanged };
    }

    // The model's output goes back verbatim (see LlmMessage "assistant_raw").
    messages.push({ role: "assistant_raw", raw: response.raw });
    const results = [];
    for (const toolCall of response.toolCalls) {
      const outcome = await executeTool({ db: deps.db, userId, now }, toolCall);
      draftChanged ||= outcome.draftChanged === true;
      results.push({ id: toolCall.id, name: toolCall.name, result: outcome.result });
    }
    messages.push({ role: "tool_results", results });
  }

  return fail("too_many_steps");
}

/**
 * Handles one text message from a user and returns what to show them.
 * It does not throw for model or quota problems; those come back as a reply
 * with `error` set.
 */
export async function handleMessage(
  deps: AssistantDeps,
  input: { userId: number; text: string },
): Promise<AssistantReply> {
  const { userId } = input;
  const text = typeof input.text === "string" ? input.text.trim() : "";

  if (text === "" || text.length > MAX_USER_MESSAGE_LENGTH) {
    return {
      reply:
        text === ""
          ? "Please type a message."
          : `That message is too long. Please keep it under ${MAX_USER_MESSAGE_LENGTH} characters.`,
      pendingExpense: await getActiveDraft(deps.db, userId),
      error: "invalid_input",
    };
  }

  await appendMessage(deps.db, userId, "user", text);

  const command = parseCommand(text);
  if (command) {
    return finish(deps, userId, await runCommand(deps, userId, command));
  }

  const history = await listRecentMessages(deps.db, userId, HISTORY_LIMIT);
  const messages: LlmMessage[] = history.map((m) => ({ role: m.role, text: m.content }));
  // A conversation sent to the model has to open with the user.
  while (messages[0]?.role === "assistant") messages.shift();

  const now = (deps.now ?? (() => new Date()))();
  const turn = await runModelTurn(deps, userId, messages, now);

  const draft = await getActiveDraft(deps.db, userId);
  let reply = turn.error ? turn.text : withoutFalseClaims(turn.text, turn.draftChanged, draft !== null);
  // The state of a new or changed draft is always reported by code, whatever the model said.
  if (turn.draftChanged && draft) reply += `\n\n${draftNotice(draft)}`;

  return finish(deps, userId, reply, turn.error);
}

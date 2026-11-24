import type { LlmMessage } from "../llm/types";
import { MAX_MESSAGE_LENGTH, appendMessage, listRecentMessages } from "../services/conversations";
import { cancelDraft, confirmExpense, getActiveDraft } from "../services/expenses";
import { describeExpense, draftNotice, submittedNotice } from "./format";
import { ERROR_TEXT, TurnFailure, createModelCaller } from "./model-caller";
import { buildSystemPrompt } from "./prompt";
import { TOOL_DECLARATIONS, executeTool } from "./tools";
import type { AssistantDeps, AssistantErrorCode, AssistantReply, TurnErrorCode } from "./types";

export type { AssistantConfig, AssistantDeps, AssistantErrorCode, AssistantReply } from "./types";

/**
 * The assistant, independent of any channel. Web and Telegram adapters call
 * the three functions exported here and render what comes back.
 *
 *   handleMessage     a text message from the user
 *   handleReceipt     a photo of a receipt (see receipts.ts)
 *   confirmDraftById  the user pressed Confirm on a specific draft
 *   cancelDraftById   the user pressed Cancel on a specific draft
 *
 * The model can read data and prepare or discard a draft. Submitting is only
 * ever done by code in this file, in response to an explicit user action.
 */

const MAX_USER_MESSAGE_LENGTH = 2000;
const HISTORY_LIMIT = 20;

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

/** Stores the assistant's words and returns the reply together with the current draft. Every turn ends here. */
export async function finish(
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
  const system = buildSystemPrompt({ now, activeDraft: await getActiveDraft(deps.db, userId) });
  const callModel = createModelCaller(deps, userId, now);
  let draftChanged = false;

  try {
    for (;;) {
      const response = await callModel({ system, messages, tools: TOOL_DECLARATIONS });
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
  } catch (error) {
    if (!(error instanceof TurnFailure)) throw error;
    // Tools that already ran keep their effect; the reply reports the true state.
    return { text: ERROR_TEXT[error.code], error: error.code, draftChanged };
  }
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

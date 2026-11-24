import type { LlmMessage } from "../llm/types";
import { MAX_MESSAGE_LENGTH, appendMessage, listRecentMessages } from "../services/conversations";
import { cancelDraft, confirmExpense, getActiveDraft } from "../services/expenses";
import { describeExpense, draftNotice, submittedNotice } from "./format";
import { ERROR_TEXT, TurnFailure, createModelCaller } from "./model-caller";
import { clearPendingReceipt, getPendingReceipt } from "./pending-receipts";
import { buildSystemPrompt } from "./prompt";
import { TOOL_DECLARATIONS, executeTool } from "./tools";
import type {
  AssistantDeps,
  AssistantErrorCode,
  AssistantReply,
  MessageMeta,
  StoredCard,
  TurnErrorCode,
} from "./types";

export type { AssistantConfig, AssistantDeps, AssistantErrorCode, AssistantReply } from "./types";

/**
 * The assistant, independent of any channel. Web and Telegram adapters call
 * the functions exported here and render what comes back.
 *
 *   handleMessage     a text message from the user
 *   handleReceipt     a photo of a receipt (see receipts.ts)
 *   confirmDraftById  the user pressed Confirm on a specific draft
 *   cancelDraftById   the user pressed Cancel on a specific draft
 *
 * The model can read data and prepare or discard a draft. Submitting is only
 * ever done by code in this file, in response to an explicit user action.
 *
 * Every reply is stored twice over: as complete text (enough for a text-only
 * channel) and, where there is something structured to show, as a card.
 */

const MAX_USER_MESSAGE_LENGTH = 2000;
const HISTORY_LIMIT = 20;

/** What a turn says: the full text, plus optional structure for richer channels. */
interface Outcome {
  text: string;
  /** The sentence to show beside a card, when it differs from `text`. */
  lead?: string;
  card?: StoredCard;
  error?: AssistantErrorCode;
}

/** Stores the assistant's words and returns the reply together with the current draft. Every turn ends here. */
export async function finish(
  deps: AssistantDeps,
  userId: number,
  outcome: Outcome,
): Promise<AssistantReply> {
  const text = outcome.text.slice(0, MAX_MESSAGE_LENGTH);
  const meta: MessageMeta = {};
  if (outcome.lead !== undefined && outcome.lead !== text) meta.lead = outcome.lead;
  if (outcome.card) meta.card = outcome.card;
  if (outcome.error) meta.error = outcome.error;

  await appendMessage(deps.db, userId, "assistant", text, meta);
  const pendingExpense = await getActiveDraft(deps.db, userId);
  return outcome.error
    ? { reply: text, pendingExpense, error: outcome.error }
    : { reply: text, pendingExpense };
}

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

async function confirm(deps: AssistantDeps, userId: number, expenseId: number): Promise<Outcome> {
  const now = (deps.now ?? (() => new Date()))();
  const result = await confirmExpense(deps.db, userId, expenseId, now);
  switch (result.outcome) {
    case "submitted":
      return {
        text: submittedNotice(result.expense),
        lead: "",
        card: { kind: "expense", event: "submitted", expenseId },
      };
    case "already_submitted":
      return {
        text: `That expense was already submitted: ${describeExpense(result.expense)}`,
        lead: "That was already submitted. Nothing was sent twice.",
        card: { kind: "expense", event: "submitted", expenseId },
      };
    case "blocked":
      return {
        text: `This draft can no longer be submitted. ${result.reasons.join(" ")} Type "cancel" to discard it, or tell me the corrected details.`,
      };
    case "not_active":
      return { text: "That draft is no longer active. It was cancelled or replaced by a newer one." };
    case "not_found":
      return { text: "I couldn't find that draft." };
  }
}

async function cancel(deps: AssistantDeps, userId: number, expenseId: number): Promise<Outcome> {
  const result = await cancelDraft(deps.db, userId, expenseId);
  switch (result.outcome) {
    case "cancelled":
    case "already_cancelled":
      return {
        text: `Draft discarded: ${describeExpense(result.expense)}`,
        lead: "",
        card: { kind: "expense", event: "cancelled", expenseId },
      };
    case "already_submitted":
      return {
        text: `That expense was already submitted, so it can't be cancelled here: ${describeExpense(result.expense)}`,
      };
    case "not_found":
      return { text: "I couldn't find that draft." };
  }
}

/** The user pressed Confirm on one specific draft. No model involved. */
export async function confirmDraftById(
  deps: AssistantDeps,
  input: { userId: number; expenseId: number },
): Promise<AssistantReply> {
  return finish(deps, input.userId, await confirm(deps, input.userId, input.expenseId));
}

/** The user pressed Cancel on one specific draft. No model involved. */
export async function cancelDraftById(
  deps: AssistantDeps,
  input: { userId: number; expenseId: number },
): Promise<AssistantReply> {
  return finish(deps, input.userId, await cancel(deps, input.userId, input.expenseId));
}

async function runCommand(deps: AssistantDeps, userId: number, command: Command): Promise<Outcome> {
  const draft = await getActiveDraft(deps.db, userId);
  if (draft) {
    return command === "confirm" ? confirm(deps, userId, draft.id) : cancel(deps, userId, draft.id);
  }
  // No draft, but a half-read receipt may be waiting: "cancel" drops that too.
  if (command === "cancel" && (await clearPendingReceipt(deps.db, userId))) {
    return { text: "Receipt details discarded." };
  }
  return { text: `There is no draft to ${command}.` };
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
  /** The most relevant card produced by the tools that ran, if any. */
  card?: StoredCard;
}

async function runModelTurn(
  deps: AssistantDeps,
  userId: number,
  messages: LlmMessage[],
  now: Date,
): Promise<TurnResult> {
  const system = buildSystemPrompt({
    now,
    activeDraft: await getActiveDraft(deps.db, userId),
    pendingReceipt: await getPendingReceipt(deps.db, userId),
  });
  const callModel = createModelCaller(deps, userId, now);
  let draftChanged = false;
  let card: StoredCard | undefined;

  try {
    for (;;) {
      const response = await callModel({ system, messages, tools: TOOL_DECLARATIONS });
      if (response.toolCalls.length === 0) {
        return { text: response.text, draftChanged, card };
      }

      // The model's output goes back verbatim (see LlmMessage "assistant_raw").
      messages.push({ role: "assistant_raw", raw: response.raw });
      const results = [];
      for (const toolCall of response.toolCalls) {
        const outcome = await executeTool({ db: deps.db, userId, now }, toolCall);
        draftChanged ||= outcome.draftChanged === true;
        // One card per reply. A change to the draft matters more than a lookup.
        if (outcome.card && (outcome.card.kind === "expense" || card?.kind !== "expense")) {
          card = outcome.card;
        }
        results.push({ id: toolCall.id, name: toolCall.name, result: outcome.result });
      }
      messages.push({ role: "tool_results", results });
    }
  } catch (error) {
    if (!(error instanceof TurnFailure)) throw error;
    // Tools that already ran keep their effect; the reply reports the true state.
    return { text: ERROR_TEXT[error.code], error: error.code, draftChanged, card };
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
  const lead = turn.error ? turn.text : withoutFalseClaims(turn.text, turn.draftChanged, draft !== null);
  // The state of a new or changed draft is always reported by code, whatever the model said.
  const reply = turn.draftChanged && draft ? `${lead}\n\n${draftNotice(draft)}` : lead;

  return finish(deps, userId, { text: reply, lead, card: turn.card, error: turn.error });
}

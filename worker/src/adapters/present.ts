import type { Card, ChatMessageDto, ErrorCode, ExpenseDto } from "../../../shared/contract";
import type { MessageMeta } from "../assistant/types";
import type { Message } from "../services/conversations";
import { getExpensesByIds } from "../services/expenses";

/**
 * Stored messages → the typed form a channel renders. Shared by every adapter,
 * so the web app's cards and Telegram's messages are built from exactly the
 * same data.
 */

/** Problems where sending the same thing again might work. */
const RETRYABLE = new Set<ErrorCode>([
  "busy",
  "provider_rate_limited",
  "timeout",
  "unavailable",
  "extraction_failed",
]);

const RECEIPT_PLACEHOLDER = "[Receipt photo]";

/**
 * Stored messages → what the browser shows. Expense cards are stored as ids;
 * here each gets the expense as it is *now*, so an old card can truthfully
 * show "replaced" or "submitted". The lookup is scoped to the user.
 */
export async function toMessageDtos(
  db: D1Database,
  userId: number,
  messages: Message[],
): Promise<ChatMessageDto[]> {
  const metas = messages.map((m) => (m.meta ?? {}) as MessageMeta);
  const ids = metas.flatMap((meta) =>
    meta.card && "expenseId" in meta.card && meta.card.expenseId ? [meta.card.expenseId] : [],
  );
  const expenses = new Map<number, ExpenseDto>(
    (await getExpensesByIds(db, userId, ids)).map((e) => [e.id, e]),
  );

  return messages.map((message, i) => {
    const meta = metas[i]!;
    const dto: ChatMessageDto = {
      id: message.id,
      role: message.role,
      // The stored text carries plain-text notices for text-only channels; a
      // channel that shows the card shows the assistant's own sentence instead.
      text: meta.lead ?? message.content,
      createdAt: message.createdAt,
    };

    if (meta.attachment) {
      dto.attachment = meta.attachment;
      dto.text = message.content.replace(RECEIPT_PLACEHOLDER, "").trim();
    }
    if (meta.error) dto.error = { code: meta.error, retryable: RETRYABLE.has(meta.error) };

    const card = meta.card;
    if (card?.kind === "expense") {
      const expense = expenses.get(card.expenseId);
      if (expense) {
        dto.card = { kind: "expense", event: card.event, expense, ...(card.changes ? { changes: card.changes } : {}) };
      }
    } else if (card?.kind === "receipt") {
      const expense = card.expenseId ? expenses.get(card.expenseId) : undefined;
      dto.card = { kind: "receipt", analysis: card.analysis, ...(expense ? { expense } : {}) };
    } else if (card) {
      dto.card = card satisfies Card;
    }
    return dto;
  });
}


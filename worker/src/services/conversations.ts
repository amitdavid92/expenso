import { ValidationError, assertPositiveInt } from "../lib/errors";

/**
 * Conversation history: one flat, ordered list of text messages per user.
 * Every query is scoped by user id, which is what keeps conversations isolated.
 */

export const ROLES = ["user", "assistant"] as const;
export type Role = (typeof ROLES)[number];

/** Telegram caps a message at 4096 characters; we stay just under for both channels. */
export const MAX_MESSAGE_LENGTH = 4000;
export const DEFAULT_HISTORY_LIMIT = 20;
export const MAX_HISTORY_LIMIT = 100;

export interface Message {
  id: number;
  role: Role;
  content: string;
  createdAt: string;
}

interface MessageRow {
  id: number;
  role: Role;
  content: string;
  created_at: string;
}

function toMessage(row: MessageRow): Message {
  return { id: row.id, role: row.role, content: row.content, createdAt: row.created_at };
}

export async function appendMessage(
  db: D1Database,
  userId: number,
  role: Role,
  content: string,
): Promise<Message> {
  assertPositiveInt(userId, "User id");
  if (!ROLES.includes(role)) {
    throw new ValidationError(`Role must be one of: ${ROLES.join(", ")}.`);
  }
  if (typeof content !== "string" || content.trim() === "") {
    throw new ValidationError("Message cannot be empty.");
  }
  if (content.length > MAX_MESSAGE_LENGTH) {
    throw new ValidationError(`Message cannot be longer than ${MAX_MESSAGE_LENGTH} characters.`);
  }

  const row = await db
    .prepare(
      "INSERT INTO messages (user_id, role, content) VALUES (?, ?, ?) RETURNING id, role, content, created_at",
    )
    .bind(userId, role, content)
    .first<MessageRow>();

  return toMessage(row!);
}

/** The user's latest `limit` messages, oldest first (the order a model or a chat UI needs). */
export async function listRecentMessages(
  db: D1Database,
  userId: number,
  limit: number = DEFAULT_HISTORY_LIMIT,
): Promise<Message[]> {
  assertPositiveInt(userId, "User id");
  assertPositiveInt(limit, "Limit");
  if (limit > MAX_HISTORY_LIMIT) {
    throw new ValidationError(`Limit cannot be more than ${MAX_HISTORY_LIMIT}.`);
  }

  const { results } = await db
    .prepare(
      "SELECT id, role, content, created_at FROM messages WHERE user_id = ? ORDER BY id DESC LIMIT ?",
    )
    .bind(userId, limit)
    .all<MessageRow>();

  return results.reverse().map(toMessage);
}

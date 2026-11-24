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

/** Structured data kept with a message (a card, an error code…). This service only stores it. */
export type MessageMetaJson = Record<string, unknown>;

export interface Message {
  id: number;
  role: Role;
  content: string;
  meta: MessageMetaJson | null;
  createdAt: string;
}

interface MessageRow {
  id: number;
  role: Role;
  content: string;
  meta: string | null;
  created_at: string;
}

const COLUMNS = "id, role, content, meta, created_at";

function toMessage(row: MessageRow): Message {
  return {
    id: row.id,
    role: row.role,
    content: row.content,
    meta: row.meta ? (JSON.parse(row.meta) as MessageMetaJson) : null,
    createdAt: row.created_at,
  };
}

/**
 * @param meta optional structured data for channels that can show more than
 *   text. `content` must always make sense without it.
 */
export async function appendMessage(
  db: D1Database,
  userId: number,
  role: Role,
  content: string,
  meta?: object,
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

  const hasMeta = meta !== undefined && Object.keys(meta).length > 0;
  const row = await db
    .prepare(
      `INSERT INTO messages (user_id, role, content, meta) VALUES (?, ?, ?, ?) RETURNING ${COLUMNS}`,
    )
    .bind(userId, role, content, hasMeta ? JSON.stringify(meta) : null)
    .first<MessageRow>();

  return toMessage(row!);
}

/** The id of this user's newest message, or 0 if they have none. */
export async function latestMessageId(db: D1Database, userId: number): Promise<number> {
  assertPositiveInt(userId, "User id");
  const row = await db
    .prepare("SELECT COALESCE(MAX(id), 0) AS id FROM messages WHERE user_id = ?")
    .bind(userId)
    .first<{ id: number }>();
  return row?.id ?? 0;
}

/** This user's messages newer than `afterId`, oldest first: what one turn added. */
export async function listMessagesAfter(
  db: D1Database,
  userId: number,
  afterId: number,
): Promise<Message[]> {
  assertPositiveInt(userId, "User id");
  if (!Number.isSafeInteger(afterId) || afterId < 0) {
    throw new ValidationError("Message id must be a whole number, zero or more.");
  }
  const { results } = await db
    .prepare(`SELECT ${COLUMNS} FROM messages WHERE user_id = ? AND id > ? ORDER BY id LIMIT ?`)
    .bind(userId, afterId, MAX_HISTORY_LIMIT)
    .all<MessageRow>();
  return results.map(toMessage);
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
      `SELECT ${COLUMNS} FROM messages WHERE user_id = ? ORDER BY id DESC LIMIT ?`,
    )
    .bind(userId, limit)
    .all<MessageRow>();

  return results.reverse().map(toMessage);
}

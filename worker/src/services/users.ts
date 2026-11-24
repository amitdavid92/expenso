import { ValidationError } from "../lib/errors";

/**
 * A user is identified by the channel they came from plus that channel's own id
 * (Telegram user id, or an anonymous web session id). The same person on two
 * channels is two users; nothing here links them.
 */

export const CHANNELS = ["web", "telegram"] as const;
export type Channel = (typeof CHANNELS)[number];

export interface User {
  id: number;
  channel: Channel;
  externalId: string;
  displayName: string | null;
}

interface UserRow {
  id: number;
  channel: Channel;
  external_id: string;
  display_name: string | null;
}

const MAX_EXTERNAL_ID_LENGTH = 128;
const MAX_DISPLAY_NAME_LENGTH = 100;

function toUser(row: UserRow): User {
  return {
    id: row.id,
    channel: row.channel,
    externalId: row.external_id,
    displayName: row.display_name,
  };
}

function validateIdentity(channel: unknown, externalId: unknown): void {
  const issues: string[] = [];
  if (!CHANNELS.includes(channel as Channel)) {
    issues.push(`Channel must be one of: ${CHANNELS.join(", ")}.`);
  }
  if (
    typeof externalId !== "string" ||
    externalId.trim() === "" ||
    externalId.length > MAX_EXTERNAL_ID_LENGTH
  ) {
    issues.push(`External id must be 1-${MAX_EXTERNAL_ID_LENGTH} characters.`);
  }
  if (issues.length > 0) throw new ValidationError(issues);
}

/**
 * Returns the user for this identity, creating it on first contact.
 * One statement, so concurrent first messages cannot create duplicates.
 */
export async function findOrCreateUser(
  db: D1Database,
  input: { channel: Channel; externalId: string; displayName?: string | null },
): Promise<User> {
  validateIdentity(input.channel, input.externalId);
  const displayName =
    typeof input.displayName === "string" && input.displayName.trim() !== ""
      ? input.displayName.trim().slice(0, MAX_DISPLAY_NAME_LENGTH)
      : null;

  const row = await db
    .prepare(
      `INSERT INTO users (channel, external_id, display_name) VALUES (?, ?, ?)
       ON CONFLICT (channel, external_id)
       DO UPDATE SET display_name = COALESCE(excluded.display_name, users.display_name)
       RETURNING id, channel, external_id, display_name`,
    )
    .bind(input.channel, input.externalId, displayName)
    .first<UserRow>();

  return toUser(row!);
}

/** Looks a user up without creating one (e.g. to check a web session id). */
export async function findUser(
  db: D1Database,
  channel: Channel,
  externalId: string,
): Promise<User | null> {
  validateIdentity(channel, externalId);
  const row = await db
    .prepare(
      "SELECT id, channel, external_id, display_name FROM users WHERE channel = ? AND external_id = ?",
    )
    .bind(channel, externalId)
    .first<UserRow>();
  return row ? toUser(row) : null;
}

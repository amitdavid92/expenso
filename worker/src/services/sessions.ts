import { findOrCreateUser } from "./users";

/**
 * Browser sessions. A session is a random token in an HttpOnly cookie; the
 * database keeps only its SHA-256 hash and the account it opens. A guest
 * session opens its own guest account; a session created by a Telegram handoff
 * opens that Telegram account.
 */

export const SESSION_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

/** 256 random bits, URL-safe. */
export function newToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** A cookie value worth looking up: the right length and alphabet. Anything else is not a session. */
export function plausibleToken(token: unknown): token is string {
  return typeof token === "string" && /^[A-Za-z0-9_-]{40,100}$/.test(token);
}

export function sessionExpiry(now: Date): string {
  return new Date(now.getTime() + SESSION_DAYS * DAY_MS).toISOString();
}

/** The account a session cookie opens, or null if it opens nothing (unknown, expired or revoked). */
export async function userForSession(db: D1Database, token: unknown, now: Date): Promise<number | null> {
  if (!plausibleToken(token)) return null;
  const row = await db
    .prepare("SELECT user_id FROM web_sessions WHERE token_hash = ? AND expires_at > ?")
    .bind(await sha256Hex(token), now.toISOString())
    .first<{ user_id: number }>();
  return row?.user_id ?? null;
}

/** A new guest: its own empty account and a session for it. */
export async function createGuestSession(db: D1Database, now: Date): Promise<{ token: string; userId: number }> {
  const token = newToken();
  const hash = await sha256Hex(token);
  // The guest account's external id is the session hash, as before, so it is unique and says nothing.
  const user = await findOrCreateUser(db, { channel: "web", externalId: `s:${hash}` });
  await db
    .prepare("INSERT INTO web_sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)")
    .bind(hash, user.id, sessionExpiry(now))
    .run();
  return { token, userId: user.id };
}

export async function deleteSession(db: D1Database, token: string): Promise<void> {
  await db.prepare("DELETE FROM web_sessions WHERE token_hash = ?").bind(await sha256Hex(token)).run();
}

/**
 * Signs an account out everywhere on the web: every browser session that opens
 * it, and every handoff link or code not yet used. Returns how many browsers
 * were signed out.
 */
export async function revokeWebAccess(db: D1Database, userId: number): Promise<number> {
  const [sessions] = await db.batch([
    db.prepare("DELETE FROM web_sessions WHERE user_id = ?").bind(userId),
    db.prepare("DELETE FROM handoff_tokens WHERE user_id = ? AND used_at IS NULL").bind(userId),
  ]);
  return sessions?.meta.changes ?? 0;
}

export interface AccountRow {
  id: number;
  channel: "web" | "telegram";
  external_id: string;
  display_name: string | null;
}

export async function getAccount(db: D1Database, userId: number): Promise<AccountRow | null> {
  return db
    .prepare("SELECT id, channel, external_id, display_name FROM users WHERE id = ?")
    .bind(userId)
    .first<AccountRow>();
}

/** What a guest workspace holds, so linking can say what stays behind. */
export async function guestContents(
  db: D1Database,
  userId: number,
): Promise<{ submitted: number; hasDraft: boolean; messages: number }> {
  const row = await db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM expenses WHERE user_id = ?1 AND status = 'submitted') AS submitted,
         (SELECT COUNT(*) FROM expenses WHERE user_id = ?1 AND status = 'draft') AS drafts,
         (SELECT COUNT(*) FROM messages WHERE user_id = ?1) AS messages`,
    )
    .bind(userId)
    .first<{ submitted: number; drafts: number; messages: number }>();
  return { submitted: row?.submitted ?? 0, hasDraft: (row?.drafts ?? 0) > 0, messages: row?.messages ?? 0 };
}

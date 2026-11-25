import { quotaDay } from "../lib/dates";
import { newToken, sessionExpiry, sha256Hex } from "./sessions";

/**
 * Handoff tickets: how a Telegram account opens in a browser.
 *
 * Only the bot issues a ticket, and only for the Telegram user who wrote to it,
 * so a ticket always points at an account Telegram has already authenticated.
 * A ticket has two forms that redeem the same way:
 *
 *   - a link token (256 random bits) carried in a URL fragment, for a tap;
 *   - a short code (8 characters) to type into a computer without Telegram.
 *
 * A ticket lasts ten minutes and works once. Neither form is stored: the token
 * as SHA-256, the code as HMAC-SHA256 under a server key (a short code is
 * cheap to guess offline from a plain hash; a keyed one is not).
 */

export const HANDOFF_MINUTES = 10;
/** Failed code attempts allowed per browser per day. */
export const BROWSER_FAILURE_LIMIT = 10;
/** Failed code attempts allowed in total per day, so new browsers cannot keep guessing. */
export const APP_FAILURE_LIMIT = 200;

/** 32 symbols, without I, L, O and 1: nothing that reads as something else. */
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ023456789";

function newCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  // 32 symbols and 256 byte values: every symbol is equally likely.
  return [...bytes].map((b) => CODE_ALPHABET[b % 32]).join("");
}

/** "K7QM4XPD" → "K7QM-4XPD", the way it is shown. */
export const formatCode = (code: string) => `${code.slice(0, 4)}-${code.slice(4)}`;

/** What someone typed → the code, or null if it cannot be one. Forgiving about case, spaces and dashes. */
export function normalizeCode(input: unknown): string | null {
  if (typeof input !== "string" || input.length > 40) return null;
  const code = input.toUpperCase().replace(/[\s-]/g, "").replaceAll("O", "0");
  return code.length === 8 && [...code].every((c) => CODE_ALPHABET.includes(c)) ? code : null;
}

async function hmacHex(key: string, text: string): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(text));
  return [...new Uint8Array(signature)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export interface IssuedHandoff {
  token: string;
  /** Formatted for display, e.g. "K7QM-4XPD". */
  code: string;
  expiresAt: string;
}

/** Issues a ticket for a Telegram account. `key` is the server secret for code hashes. */
export async function issueHandoff(db: D1Database, userId: number, key: string, now: Date): Promise<IssuedHandoff> {
  const token = newToken();
  const code = newCode();
  const expiresAt = new Date(now.getTime() + HANDOFF_MINUTES * 60_000).toISOString();
  await db.batch([
    // Housekeeping: tickets that can no longer be used serve no purpose.
    db.prepare("DELETE FROM handoff_tokens WHERE expires_at <= ? AND used_at IS NULL").bind(now.toISOString()),
    db
      .prepare("INSERT INTO handoff_tokens (user_id, link_hash, code_hash, expires_at) VALUES (?, ?, ?, ?)")
      .bind(userId, await sha256Hex(token), await hmacHex(key, code), expiresAt),
  ]);
  return { token, code: formatCode(code), expiresAt };
}

export type HandoffLookup =
  | { status: "valid"; id: number; userId: number }
  | { status: "used" | "expired" }
  | { status: "unknown" };

/** Finds a ticket by link token or by code, without using it. */
export async function findHandoff(
  db: D1Database,
  credential: { token: string } | { code: string },
  key: string,
  now: Date,
): Promise<HandoffLookup> {
  const row =
    "token" in credential
      ? await db
          .prepare("SELECT id, user_id, expires_at, used_at FROM handoff_tokens WHERE link_hash = ?")
          .bind(await sha256Hex(credential.token))
          .first<{ id: number; user_id: number; expires_at: string; used_at: string | null }>()
      : await db
          .prepare("SELECT id, user_id, expires_at, used_at FROM handoff_tokens WHERE code_hash = ?")
          .bind(await hmacHex(key, credential.code))
          .first<{ id: number; user_id: number; expires_at: string; used_at: string | null }>();
  if (!row) return { status: "unknown" };
  if (row.used_at) return { status: "used" };
  if (row.expires_at <= now.toISOString()) return { status: "expired" };
  return { status: "valid", id: row.id, userId: row.user_id };
}

/**
 * Uses a ticket and creates the browser session it grants, in one transaction:
 * the ticket is marked used and the session row is inserted only if this very
 * call marked it. If anything fails, neither happens and the ticket still works.
 * Returns false if the ticket was already used, expired, or taken by a
 * simultaneous redemption.
 */
export async function redeemHandoff(
  db: D1Database,
  handoffId: number,
  sessionTokenHash: string,
  now: Date,
): Promise<boolean> {
  const stamp = now.toISOString();
  const [, inserted] = await db.batch([
    db
      .prepare(
        "UPDATE handoff_tokens SET used_at = ?, session_hash = ? WHERE id = ? AND used_at IS NULL AND expires_at > ?",
      )
      .bind(stamp, sessionTokenHash, handoffId, stamp),
    db
      .prepare(
        `INSERT INTO web_sessions (token_hash, user_id, expires_at)
         SELECT session_hash, user_id, ? FROM handoff_tokens WHERE id = ? AND session_hash = ?`,
      )
      .bind(sessionExpiry(now), handoffId, sessionTokenHash),
  ]);
  return (inserted?.meta.changes ?? 0) === 1;
}

/** Marks a ticket used without creating a session (the browser already had this account). */
export async function spendHandoff(db: D1Database, handoffId: number, now: Date): Promise<boolean> {
  const stamp = now.toISOString();
  const result = await db
    .prepare("UPDATE handoff_tokens SET used_at = ? WHERE id = ? AND used_at IS NULL AND expires_at > ?")
    .bind(stamp, handoffId, stamp)
    .run();
  return result.meta.changes === 1;
}

const failureScopes = (browserUserId: number) => [`link_fail:${browserUserId}`, "link_fail:app"];

/** True if this browser, or the app as a whole, has used up today's failed code attempts. */
export async function codeAttemptsExhausted(db: D1Database, browserUserId: number, now: Date): Promise<boolean> {
  const [browser, app] = failureScopes(browserUserId);
  const { results } = await db
    .prepare("SELECT scope, count FROM usage_daily WHERE day = ? AND scope IN (?, ?)")
    .bind(quotaDay(now), browser, app)
    .all<{ scope: string; count: number }>();
  const count = (scope: string) => results.find((r) => r.scope === scope)?.count ?? 0;
  return count(browser!) >= BROWSER_FAILURE_LIMIT || count(app!) >= APP_FAILURE_LIMIT;
}

/** Counts one wrong code against this browser and against the app. */
export async function recordCodeFailure(db: D1Database, browserUserId: number, now: Date): Promise<void> {
  const day = quotaDay(now);
  await db.batch(
    failureScopes(browserUserId).map((scope) =>
      db
        .prepare(
          `INSERT INTO usage_daily (day, scope, count) VALUES (?, ?, 1)
           ON CONFLICT (day, scope) DO UPDATE SET count = count + 1`,
        )
        .bind(day, scope),
    ),
  );
}

/**
 * The address handoff links point at. It is configuration, never taken from a
 * request: an https origin, or http only for a local address. Anything else
 * means no links are made (codes still work).
 */
export function validWebUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) return null;
  if (url.username || url.password || url.search || url.hash) return null;
  return url.origin;
}

/** The link for a ticket. The token rides in the fragment, which browsers never send to a server. */
export const handoffLink = (webUrl: string, token: string) => `${webUrl}/#link=${token}`;

import { quotaDay } from "../lib/dates";
import { ValidationError, assertPositiveInt } from "../lib/errors";

/**
 * Usage limits that protect the free Gemini quota:
 *
 *   - a daily allowance per user,
 *   - a daily allowance for the whole application,
 *   - optionally, a rolling per-minute limit for the whole application.
 *
 * Call `consumeQuota` before each model request; if it says no, do not call
 * the model.
 */

export type QuotaResult =
  | { allowed: true; userRemaining: number; appRemaining: number }
  | { allowed: false; exhausted: "user" | "app" | "minute" };

export interface QuotaRequest {
  userId: number;
  userDailyLimit: number;
  appDailyLimit: number;
  /** Requests the whole application may make in any 60 seconds. Leave out for no such limit. */
  appPerMinuteLimit?: number;
  /** Defaults to the current time. Counters are per US Pacific day, like Gemini's quota. */
  now?: Date;
}

const APP_SCOPE = "app";
const MINUTE_MS = 60_000;

function assertLimit(value: unknown, name: string): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new ValidationError(`${name} must be a whole number, zero or more.`);
  }
}

/**
 * Reserves a slot in the rolling minute. One INSERT that only happens while
 * fewer than `limit` requests were logged in the last 60 seconds, so concurrent
 * requests cannot overshoot. Returns the row id, or null when the minute is full.
 */
async function takeMinuteSlot(db: D1Database, nowMs: number, limit: number): Promise<number | null> {
  const [, inserted] = await db.batch<{ id: number }>([
    db.prepare("DELETE FROM llm_request_log WHERE at_ms <= ?").bind(nowMs - MINUTE_MS),
    db
      .prepare(
        `INSERT INTO llm_request_log (at_ms)
         SELECT ?1
         WHERE (SELECT COUNT(*) FROM llm_request_log WHERE at_ms > ?1 - ${MINUTE_MS}) < ?2
         RETURNING id`,
      )
      .bind(nowMs, limit),
  ]);
  return inserted?.results[0]?.id ?? null;
}

/**
 * Takes one unit from the user's and the application's daily allowance (both
 * or neither) and, if a per-minute limit is set, one slot in the rolling minute.
 *
 * The daily part is a single SQL statement: it adds 1 to both counters only if
 * neither has reached its limit. D1 runs a statement atomically, so concurrent
 * requests cannot push a counter past its limit. A refused request costs
 * nothing: the minute slot is checked first and handed back if a daily limit
 * then refuses.
 */
export async function consumeQuota(db: D1Database, request: QuotaRequest): Promise<QuotaResult> {
  const { userId, userDailyLimit, appDailyLimit } = request;
  assertPositiveInt(userId, "User id");
  assertLimit(userDailyLimit, "Per-user daily limit");
  assertLimit(appDailyLimit, "Application daily limit");

  if (userDailyLimit === 0) return { allowed: false, exhausted: "user" };
  if (appDailyLimit === 0) return { allowed: false, exhausted: "app" };

  const now = request.now ?? new Date();
  let minuteSlot: number | null = null;
  if (request.appPerMinuteLimit !== undefined) {
    assertLimit(request.appPerMinuteLimit, "Per-minute limit");
    if (request.appPerMinuteLimit === 0) return { allowed: false, exhausted: "minute" };
    minuteSlot = await takeMinuteSlot(db, now.getTime(), request.appPerMinuteLimit);
    if (minuteSlot === null) return { allowed: false, exhausted: "minute" };
  }

  const day = quotaDay(now);
  const userScope = `user:${userId}`;

  const { results } = await db
    .prepare(
      `INSERT INTO usage_daily (day, scope, count)
       SELECT ?1, s.scope, 1
       FROM (SELECT '${APP_SCOPE}' AS scope UNION ALL SELECT ?2 AS scope) AS s
       WHERE NOT EXISTS (
         SELECT 1 FROM usage_daily
         WHERE day = ?1
           AND ((scope = '${APP_SCOPE}' AND count >= ?3) OR (scope = ?2 AND count >= ?4))
       )
       ON CONFLICT (day, scope) DO UPDATE SET count = count + 1
       RETURNING scope, count`,
    )
    .bind(day, userScope, appDailyLimit, userDailyLimit)
    .all<{ scope: string; count: number }>();

  if (results.length > 0) {
    const used = (scope: string) => results.find((r) => r.scope === scope)?.count ?? 0;
    return {
      allowed: true,
      userRemaining: userDailyLimit - used(userScope),
      appRemaining: appDailyLimit - used(APP_SCOPE),
    };
  }

  // Refused by a daily limit: give the minute slot back.
  if (minuteSlot !== null) {
    await db.prepare("DELETE FROM llm_request_log WHERE id = ?").bind(minuteSlot).run();
  }

  // Read the user's counter only to say which limit was hit.
  const userRow = await db
    .prepare("SELECT count FROM usage_daily WHERE day = ? AND scope = ?")
    .bind(day, userScope)
    .first<{ count: number }>();

  return {
    allowed: false,
    exhausted: (userRow?.count ?? 0) >= userDailyLimit ? "user" : "app",
  };
}

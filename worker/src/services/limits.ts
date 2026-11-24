import { quotaDay } from "../lib/dates";
import { ValidationError, assertPositiveInt } from "../lib/errors";

/**
 * Daily usage limits that protect the free Gemini quota: one allowance per user
 * and one for the whole application. Call `consumeQuota` before each model
 * request; if it says no, do not call the model.
 */

export type QuotaResult =
  | { allowed: true; userRemaining: number; appRemaining: number }
  | { allowed: false; exhausted: "user" | "app" };

export interface QuotaRequest {
  userId: number;
  userDailyLimit: number;
  appDailyLimit: number;
  /** Defaults to the current time. Counters are per US Pacific day, like Gemini's quota. */
  now?: Date;
}

const APP_SCOPE = "app";

function assertLimit(value: unknown, name: string): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new ValidationError(`${name} must be a whole number, zero or more.`);
  }
}

/**
 * Takes one unit from both the user's and the application's daily allowance,
 * or from neither.
 *
 * It is a single SQL statement: it adds 1 to both counters only if neither has
 * reached its limit. D1 runs a statement atomically, so concurrent requests
 * cannot push a counter past its limit, and a refused request costs nothing.
 */
export async function consumeQuota(db: D1Database, request: QuotaRequest): Promise<QuotaResult> {
  const { userId, userDailyLimit, appDailyLimit } = request;
  assertPositiveInt(userId, "User id");
  assertLimit(userDailyLimit, "Per-user daily limit");
  assertLimit(appDailyLimit, "Application daily limit");

  if (userDailyLimit === 0) return { allowed: false, exhausted: "user" };
  if (appDailyLimit === 0) return { allowed: false, exhausted: "app" };

  const day = quotaDay(request.now ?? new Date());
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

  // Refused. Read the user's counter only to say which limit was hit.
  const userRow = await db
    .prepare("SELECT count FROM usage_daily WHERE day = ? AND scope = ?")
    .bind(day, userScope)
    .first<{ count: number }>();

  return {
    allowed: false,
    exhausted: (userRow?.count ?? 0) >= userDailyLimit ? "user" : "app",
  };
}

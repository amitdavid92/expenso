import type { AssistantConfig } from "./types";

/**
 * Limits sit below the free-tier quota verified in Google AI Studio for
 * gemini-3.5-flash-lite (15 requests/minute, 500 requests/day), leaving
 * headroom for requests made outside the app (tests, the local chat script).
 * If the provider's quota is hit anyway, its HTTP 429 is handled as a normal,
 * friendly failure.
 */
const DEFAULTS: AssistantConfig = {
  userDailyLimit: 60,
  appDailyLimit: 400,
  appPerMinuteLimit: 12,
  maxRounds: 5,
  // Normal answers take 0.5-4 s. Short enough that a hung request can be retried within the deadline.
  requestTimeoutMs: 8_000,
  // Measured on the free tier: 3-7 s for a clear receipt, more under load.
  receiptRequestTimeoutMs: 18_000,
  // Leaves room inside Cloudflare's 30-second waitUntil window to send a failure message.
  deadlineMs: 22_000,
  // Gemini's free tier often answers 503 "high demand" for a moment; two spaced retries ride most of that out.
  retryDelaysMs: [800, 2000],
};

function limit(value: unknown, fallback: number, name: string): number {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (Number.isSafeInteger(parsed) && parsed >= 0) return parsed;
  console.warn(`config_invalid name=${name}; using default`);
  return fallback;
}

export function assistantConfigFromEnv(env: {
  USER_DAILY_LLM_LIMIT?: unknown;
  APP_DAILY_LLM_LIMIT?: unknown;
  APP_PER_MINUTE_LLM_LIMIT?: unknown;
}): AssistantConfig {
  return {
    ...DEFAULTS,
    userDailyLimit: limit(env.USER_DAILY_LLM_LIMIT, DEFAULTS.userDailyLimit, "USER_DAILY_LLM_LIMIT"),
    appDailyLimit: limit(env.APP_DAILY_LLM_LIMIT, DEFAULTS.appDailyLimit, "APP_DAILY_LLM_LIMIT"),
    appPerMinuteLimit: limit(
      env.APP_PER_MINUTE_LLM_LIMIT,
      DEFAULTS.appPerMinuteLimit,
      "APP_PER_MINUTE_LLM_LIMIT",
    ),
  };
}

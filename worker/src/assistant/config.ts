import type { AssistantConfig } from "./assistant";

/**
 * Daily limits are deliberately far below what Gemini's free tier is expected
 * to allow, because the real quota is per Google project, changes without
 * notice, and can only be read in AI Studio. If the provider's quota turns out
 * to be lower, its HTTP 429 is handled as a normal, friendly failure.
 */
const DEFAULTS: AssistantConfig = {
  userDailyLimit: 30,
  appDailyLimit: 150,
  maxRounds: 5,
  // Normal answers take 0.5-4 s. Short enough that a hung request can be retried within the deadline.
  requestTimeoutMs: 8_000,
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
}): AssistantConfig {
  return {
    ...DEFAULTS,
    userDailyLimit: limit(env.USER_DAILY_LLM_LIMIT, DEFAULTS.userDailyLimit, "USER_DAILY_LLM_LIMIT"),
    appDailyLimit: limit(env.APP_DAILY_LLM_LIMIT, DEFAULTS.appDailyLimit, "APP_DAILY_LLM_LIMIT"),
  };
}

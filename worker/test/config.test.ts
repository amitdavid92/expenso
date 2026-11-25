import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { assistantConfigFromEnv } from "../src/assistant/config";

describe("assistantConfigFromEnv", () => {
  it("reads the limits from the environment", () => {
    expect(assistantConfigFromEnv({ USER_DAILY_LLM_LIMIT: "7", APP_DAILY_LLM_LIMIT: "70" })).toMatchObject({
      userDailyLimit: 7,
      appDailyLimit: 70,
      maxRounds: 5,
    });
  });

  it.each([undefined, "", "many", "-1", "2.5"])("falls back to a safe default for %j", (value) => {
    const config = assistantConfigFromEnv({ USER_DAILY_LLM_LIMIT: value, APP_DAILY_LLM_LIMIT: value });
    expect(config.userDailyLimit).toBe(60);
    expect(config.appDailyLimit).toBe(400);
    expect(config.appPerMinuteLimit).toBe(12);
  });

  it("keeps the whole turn inside the 30-second background window, with time to spare", () => {
    const config = assistantConfigFromEnv({});
    expect(config.deadlineMs).toBeLessThanOrEqual(25_000);
    expect(config.requestTimeoutMs).toBeLessThan(config.deadlineMs);
    expect(config.receiptRequestTimeoutMs).toBeGreaterThan(config.requestTimeoutMs);
    expect(config.receiptRequestTimeoutMs).toBeLessThan(config.deadlineMs);
  });

  it("has a model and limits configured in wrangler.jsonc", () => {
    expect(env.GEMINI_MODEL).toMatch(/^gemini-/);
    expect(assistantConfigFromEnv(env)).toMatchObject({ userDailyLimit: 60, appDailyLimit: 400, appPerMinuteLimit: 12 });
    expect(assistantConfigFromEnv(env).userDailyLimit).toBeLessThanOrEqual(assistantConfigFromEnv(env).appDailyLimit);
  });
});

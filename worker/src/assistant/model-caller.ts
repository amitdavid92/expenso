import { LlmError, type LlmRequest, type LlmResponse } from "../llm/types";
import { consumeQuota } from "../services/limits";
import type { AssistantDeps, TurnErrorCode } from "./types";

/**
 * The one place a model request is made from. Chat and receipt analysis both
 * go through it, so every request, whatever it is for, gets the same quota
 * check, timeout, retry and request-count rules.
 */

export const ERROR_TEXT: Record<TurnErrorCode, string> = {
  user_limit:
    'You have reached your daily limit for assistant messages. It resets at midnight Pacific time. You can still type "confirm" or "cancel" for a pending draft.',
  app_limit:
    'The assistant has used up its free daily allowance. It resets at midnight Pacific time. You can still type "confirm" or "cancel" for a pending draft.',
  busy: "The assistant is handling a lot of requests right now. Please try again in a minute.",
  provider_rate_limited: "The AI service is busy right now. Please wait a minute and try again.",
  timeout: "That took too long, so I stopped. Please try again.",
  unavailable: "I couldn't reach the AI service just now. Please try again in a moment.",
  too_many_steps:
    "I couldn't finish that in a reasonable number of steps. Please try rephrasing it, or ask for one thing at a time.",
};

/** A model request could not be completed. `code` says why, in terms the user can be told. */
export class TurnFailure extends Error {
  readonly code: TurnErrorCode;

  constructor(code: TurnErrorCode) {
    super(code);
    this.name = "TurnFailure";
    this.code = code;
  }
}

function errorCodeFor(error: unknown): TurnErrorCode {
  if (error instanceof LlmError) {
    if (error.kind === "rate_limited") return "provider_rate_limited";
    if (error.kind === "timeout") return "timeout";
  }
  return "unavailable";
}

const QUOTA_ERROR = { user: "user_limit", app: "app_limit", minute: "busy" } as const;

/** Runs one model request and guarantees it ends by the timeout, even if the client hangs. */
function generateWithTimeout(
  deps: AssistantDeps,
  request: Omit<LlmRequest, "signal">,
  timeoutMs: number,
): Promise<LlmResponse> {
  const signal = AbortSignal.timeout(timeoutMs);
  const expired = new Promise<never>((_resolve, reject) => {
    // A request that hung has changed nothing on our side, so it may be retried.
    signal.addEventListener("abort", () => reject(new LlmError("timeout", { retryable: true })), {
      once: true,
    });
  });
  return Promise.race([deps.llm.generate({ ...request, signal }), expired]);
}

export type ModelCaller = (request: Omit<LlmRequest, "signal">) => Promise<LlmResponse>;

/**
 * Creates the caller for one user turn. The deadline, the request count and
 * the retry budget belong to the turn and are shared by every request made
 * through it. A request either returns a response or throws `TurnFailure`.
 */
export function createModelCaller(
  deps: AssistantDeps,
  userId: number,
  now: Date,
  options: { requestTimeoutMs?: number } = {},
): ModelCaller {
  const { config } = deps;
  const requestTimeoutMs = options.requestTimeoutMs ?? config.requestTimeoutMs;
  const deadlineAt = Date.now() + config.deadlineMs;
  let requestsMade = 0;
  let retries = 0;

  return async function callModel(request) {
    for (;;) {
      if (requestsMade >= config.maxRounds) throw new TurnFailure("too_many_steps");

      const remainingMs = deadlineAt - Date.now();
      if (remainingMs <= 0) throw new TurnFailure("timeout");

      // Quota is taken before every real request: first tries, tool rounds and retries alike.
      const quota = await consumeQuota(deps.db, {
        userId,
        userDailyLimit: config.userDailyLimit,
        appDailyLimit: config.appDailyLimit,
        appPerMinuteLimit: config.appPerMinuteLimit,
        now,
      });
      if (!quota.allowed) throw new TurnFailure(QUOTA_ERROR[quota.exhausted]);

      requestsMade++;
      try {
        return await generateWithTimeout(deps, request, Math.min(requestTimeoutMs, remainingMs));
      } catch (error) {
        // Only the kind and HTTP status are logged: never message text, images,
        // arguments or credentials.
        console.warn(
          error instanceof LlmError
            ? `llm_request_failed kind=${error.kind} status=${error.status ?? "none"}`
            : "llm_request_failed kind=unexpected",
        );
        const delayMs = config.retryDelaysMs[retries];
        if (
          error instanceof LlmError &&
          error.retryable &&
          delayMs !== undefined &&
          Date.now() + delayMs < deadlineAt
        ) {
          // Safe to repeat: nothing is changed until a response arrives. The
          // pause lets a brief provider spike ("high demand") pass.
          retries++;
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          continue;
        }
        throw new TurnFailure(errorCodeFor(error));
      }
    }
  };
}

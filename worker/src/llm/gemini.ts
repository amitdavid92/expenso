import {
  type LlmClient,
  LlmError,
  type LlmMessage,
  type LlmRequest,
  type LlmResponse,
  type ToolCall,
} from "./types";

/**
 * Gemini over plain `fetch`, using the generateContent REST API.
 *
 * Google now also offers a newer "Interactions" API. generateContent is still
 * supported and every model lists it; its request and response format is fully
 * documented, including the thought-signature rules this client relies on.
 */

const BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

export interface GeminiOptions {
  apiKey: string;
  /** e.g. "gemini-3.5-flash-lite". Comes from the GEMINI_MODEL variable. */
  model: string;
  /** Replaceable for tests. */
  fetch?: typeof fetch;
}

interface GeminiContent {
  role: "user" | "model";
  parts: unknown[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toContent(message: LlmMessage): unknown {
  switch (message.role) {
    case "user":
      return { role: "user", parts: [{ text: message.text }] } satisfies GeminiContent;
    case "assistant":
      return { role: "model", parts: [{ text: message.text }] } satisfies GeminiContent;
    case "assistant_raw":
      // Sent back untouched. Gemini 3 and later reject the request (HTTP 400)
      // if a function call comes back without the thoughtSignature it was issued with.
      return message.raw;
    case "tool_results":
      // All results of one model step go in a single content, in call order.
      return {
        role: "user",
        parts: message.results.map((r) => ({
          functionResponse: {
            ...(r.id !== undefined ? { id: r.id } : {}),
            name: r.name,
            response: r.result,
          },
        })),
      } satisfies GeminiContent;
  }
}

function parseResponse(body: unknown): LlmResponse {
  if (!isObject(body)) throw new LlmError("invalid_response");

  const candidate = Array.isArray(body.candidates) ? body.candidates[0] : undefined;
  if (!isObject(candidate)) {
    const blocked = isObject(body.promptFeedback) && body.promptFeedback.blockReason;
    throw new LlmError(blocked ? "blocked" : "invalid_response");
  }

  const content = candidate.content;
  if (!isObject(content) || !Array.isArray(content.parts)) {
    throw new LlmError(candidate.finishReason === "SAFETY" ? "blocked" : "invalid_response");
  }

  let text = "";
  const toolCalls: ToolCall[] = [];
  for (const part of content.parts) {
    if (!isObject(part)) continue;
    if (isObject(part.functionCall)) {
      const { name, args, id } = part.functionCall;
      if (typeof name !== "string" || name === "") throw new LlmError("invalid_response");
      toolCalls.push({ id: typeof id === "string" ? id : undefined, name, args: args ?? {} });
    } else if (typeof part.text === "string" && part.thought !== true) {
      text += part.text;
    }
  }

  text = text.trim();
  if (text === "" && toolCalls.length === 0) throw new LlmError("invalid_response");

  return { text, toolCalls, raw: content };
}

export function createGeminiClient(options: GeminiOptions): LlmClient {
  const fetchImpl = options.fetch ?? fetch;
  const url = `${BASE_URL}/models/${encodeURIComponent(options.model)}:generateContent`;

  return {
    async generate(request: LlmRequest): Promise<LlmResponse> {
      let response: Response;
      try {
        response = await fetchImpl(url, {
          method: "POST",
          // The key travels in a header so it can never end up in a logged URL.
          headers: { "Content-Type": "application/json", "x-goog-api-key": options.apiKey },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: request.system }] },
            contents: request.messages.map(toContent),
            tools: [{ functionDeclarations: request.tools }],
          }),
          signal: request.signal,
        });
      } catch {
        if (request.signal?.aborted) throw new LlmError("timeout");
        throw new LlmError("network", { retryable: true });
      }

      if (!response.ok) {
        // The error body is deliberately not read: it can echo request content.
        const status = response.status;
        if (status === 429) throw new LlmError("rate_limited", { status });
        throw new LlmError("provider_error", { status, retryable: status >= 500 });
      }

      let body: unknown;
      try {
        body = await response.json();
      } catch {
        if (request.signal?.aborted) throw new LlmError("timeout");
        throw new LlmError("invalid_response", { retryable: true });
      }
      return parseResponse(body);
    },
  };
}

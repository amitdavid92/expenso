/**
 * The assistant talks to a language model only through this interface, so the
 * provider can be swapped and tests can use a scripted fake.
 */

export interface ToolDeclaration {
  name: string;
  description: string;
  /** JSON Schema for the arguments object. */
  parameters: Record<string, unknown>;
}

/** The model asking for a tool to be run. Arguments are untrusted until validated. */
export interface ToolCall {
  id?: string;
  name: string;
  args: unknown;
}

export interface ToolResult {
  /** The id of the call this answers, when the model supplied one. */
  id?: string;
  name: string;
  result: Record<string, unknown>;
}

export type LlmMessage =
  | { role: "user"; text: string }
  /** An assistant message from an earlier, finished turn. */
  | { role: "assistant"; text: string }
  /**
   * The model's output from the turn in progress, exactly as the provider
   * returned it (`LlmResponse.raw`). It is opaque to the assistant and must be
   * sent back unchanged: providers attach metadata such as thought signatures
   * that they verify on the next request.
   */
  | { role: "assistant_raw"; raw: unknown }
  | { role: "tool_results"; results: ToolResult[] };

export interface LlmRequest {
  system: string;
  messages: LlmMessage[];
  tools: ToolDeclaration[];
  /** Aborting it cancels the request; the client reports that as a timeout. */
  signal?: AbortSignal;
}

export interface LlmResponse {
  /** Text meant for the user; empty when the model only asked for tools. */
  text: string;
  toolCalls: ToolCall[];
  /** The provider's own representation of this output. See `assistant_raw`. */
  raw: unknown;
}

export interface LlmClient {
  generate(request: LlmRequest): Promise<LlmResponse>;
}

export type LlmErrorKind =
  | "rate_limited"
  | "timeout"
  | "network"
  | "provider_error"
  | "invalid_response"
  | "blocked";

/**
 * Every way a model request can fail. The message is a fixed description per
 * kind: it never contains provider error text, request content or credentials,
 * so it is safe to log.
 */
export class LlmError extends Error {
  readonly kind: LlmErrorKind;
  /** True when sending the same request again might succeed. */
  readonly retryable: boolean;
  readonly status?: number;

  constructor(kind: LlmErrorKind, options: { retryable?: boolean; status?: number } = {}) {
    super(`LLM request failed: ${kind}${options.status ? ` (HTTP ${options.status})` : ""}`);
    this.name = "LlmError";
    this.kind = kind;
    this.retryable = options.retryable ?? false;
    this.status = options.status;
  }
}

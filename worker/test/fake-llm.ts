import type { LlmClient, LlmRequest, LlmResponse } from "../src/llm/types";

type Step = LlmResponse | Error | ((request: LlmRequest) => LlmResponse | Promise<LlmResponse>);

/**
 * A scripted model: each request gets the next step. It records what it was
 * sent, and an unscripted extra request fails the conversation loudly.
 */
export class FakeLlm implements LlmClient {
  readonly requests: LlmRequest[] = [];
  private readonly steps: Step[];

  constructor(...steps: Step[]) {
    this.steps = steps;
  }

  async generate(request: LlmRequest): Promise<LlmResponse> {
    this.requests.push({ ...request, messages: [...request.messages] });
    const step = this.steps.shift();
    if (!step) throw new Error("FakeLlm: unexpected extra request");
    if (step instanceof Error) throw step;
    return typeof step === "function" ? step(request) : step;
  }
}

/** The model answers the user in text. */
export function say(text: string): LlmResponse {
  return { text, toolCalls: [], raw: { role: "model", parts: [{ text }] } };
}

/** The model asks for one or more tools. `raw` carries a signature, like the real API. */
export function call(...calls: { name: string; args?: unknown; id?: string }[]): LlmResponse {
  return {
    text: "",
    toolCalls: calls.map((c) => ({ id: c.id, name: c.name, args: c.args ?? {} })),
    raw: {
      role: "model",
      parts: calls.map((c) => ({
        functionCall: { name: c.name, args: c.args ?? {}, id: c.id },
        thoughtSignature: `signature-for-${c.name}`,
      })),
    },
  };
}

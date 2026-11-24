import { describe, expect, it } from "vitest";
import { createGeminiClient } from "../src/llm/gemini";
import { LlmError, type LlmRequest } from "../src/llm/types";

const API_KEY = "test-key-do-not-leak";

interface Captured {
  url: string;
  headers: Headers;
  body: Record<string, any>;
}

/** A stand-in for `fetch` that records the request and replies with a canned response. */
function stubFetch(reply: () => Response | Promise<Response>) {
  const calls: Captured[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body)),
    });
    return reply();
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const modelReply = (parts: unknown[]) => ({
  candidates: [{ content: { role: "model", parts }, finishReason: "STOP" }],
});

const request: LlmRequest = {
  system: "You are Expenso.",
  messages: [{ role: "user", text: "hello" }],
  tools: [
    {
      name: "get_policy",
      description: "Company policy",
      parameters: { type: "object", properties: {} },
    },
  ],
};

function client(fetchImpl: typeof fetch) {
  return createGeminiClient({ apiKey: API_KEY, model: "gemini-test-model", fetch: fetchImpl });
}

describe("Gemini client: request", () => {
  it("calls the configured model and sends the key in a header, never in the URL", async () => {
    const { calls, fetchImpl } = stubFetch(() => json(modelReply([{ text: "hi" }])));

    await client(fetchImpl).generate(request);

    expect(calls[0]!.url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-test-model:generateContent",
    );
    expect(calls[0]!.url).not.toContain(API_KEY);
    expect(calls[0]!.headers.get("x-goog-api-key")).toBe(API_KEY);
  });

  it("sends the system prompt, the tools and the conversation", async () => {
    const { calls, fetchImpl } = stubFetch(() => json(modelReply([{ text: "hi" }])));

    await client(fetchImpl).generate({
      ...request,
      messages: [
        { role: "user", text: "I spent $42" },
        { role: "assistant", text: "Where?" },
        { role: "user", text: "Cafe Nero" },
      ],
    });

    const body = calls[0]!.body;
    expect(body.systemInstruction).toEqual({ parts: [{ text: "You are Expenso." }] });
    expect(body.tools).toEqual([{ functionDeclarations: request.tools }]);
    expect(body.contents).toEqual([
      { role: "user", parts: [{ text: "I spent $42" }] },
      { role: "model", parts: [{ text: "Where?" }] },
      { role: "user", parts: [{ text: "Cafe Nero" }] },
    ]);
  });

  it("sends the model's earlier output back exactly as it was received", async () => {
    const { calls, fetchImpl } = stubFetch(() => json(modelReply([{ text: "done" }])));
    const raw = {
      role: "model",
      parts: [
        {
          functionCall: { name: "get_policy", args: {}, id: "call_1" },
          thoughtSignature: "c2lnbmF0dXJl",
          someFutureField: { keep: true },
        },
      ],
    };

    await client(fetchImpl).generate({
      ...request,
      messages: [
        { role: "user", text: "what is the policy?" },
        { role: "assistant_raw", raw },
        { role: "tool_results", results: [{ id: "call_1", name: "get_policy", result: { ok: true } }] },
      ],
    });

    const contents = calls[0]!.body.contents;
    expect(contents[1]).toEqual(raw);
    expect(contents[2]).toEqual({
      role: "user",
      parts: [{ functionResponse: { id: "call_1", name: "get_policy", response: { ok: true } } }],
    });
  });

  it("returns all results of parallel tool calls together, in order", async () => {
    const { calls, fetchImpl } = stubFetch(() => json(modelReply([{ text: "done" }])));

    await client(fetchImpl).generate({
      ...request,
      messages: [
        { role: "user", text: "q" },
        { role: "assistant_raw", raw: { role: "model", parts: [] } },
        {
          role: "tool_results",
          results: [
            { id: "a", name: "get_policy", result: { n: 1 } },
            { name: "list_expenses", result: { n: 2 } },
          ],
        },
      ],
    });

    expect(calls[0]!.body.contents[2].parts).toEqual([
      { functionResponse: { id: "a", name: "get_policy", response: { n: 1 } } },
      { functionResponse: { name: "list_expenses", response: { n: 2 } } },
    ]);
  });
});

describe("Gemini client: images and structured output", () => {
  it("sends an image before the text of the same message", async () => {
    const { calls, fetchImpl } = stubFetch(() => json(modelReply([{ text: "{}" }])));

    await client(fetchImpl).generate({
      system: "Extract.",
      messages: [{ role: "user", text: "Extract the receipt.", images: [{ mimeType: "image/png", base64: "aGVsbG8=" }] }],
    });

    expect(calls[0]!.body.contents).toEqual([
      {
        role: "user",
        parts: [{ inlineData: { mimeType: "image/png", data: "aGVsbG8=" } }, { text: "Extract the receipt." }],
      },
    ]);
  });

  it("asks for JSON matching the schema when one is given", async () => {
    const { calls, fetchImpl } = stubFetch(() => json(modelReply([{ text: "{}" }])));
    const jsonSchema = { type: "object", properties: { total: { type: ["number", "null"] } }, required: ["total"] };

    await client(fetchImpl).generate({ system: "Extract.", messages: [{ role: "user", text: "go" }], jsonSchema });

    expect(calls[0]!.body.generationConfig).toEqual({
      responseFormat: { text: { mimeType: "APPLICATION_JSON", schema: jsonSchema } },
    });
  });

  it("offers no tools at all when none are given", async () => {
    const { calls, fetchImpl } = stubFetch(() => json(modelReply([{ text: "{}" }])));

    await client(fetchImpl).generate({ system: "Extract.", messages: [{ role: "user", text: "go" }] });

    expect(calls[0]!.body).not.toHaveProperty("tools");
    expect(calls[0]!.body).not.toHaveProperty("generationConfig");
  });

  it("leaves an ordinary text conversation exactly as before", async () => {
    const { calls, fetchImpl } = stubFetch(() => json(modelReply([{ text: "hi" }])));

    await client(fetchImpl).generate(request);

    expect(calls[0]!.body.contents).toEqual([{ role: "user", parts: [{ text: "hello" }] }]);
    expect(calls[0]!.body).not.toHaveProperty("generationConfig");
  });
});

describe("Gemini client: response", () => {
  it("returns the text of a plain reply", async () => {
    const { fetchImpl } = stubFetch(() => json(modelReply([{ text: "Hello " }, { text: "there" }])));

    const response = await client(fetchImpl).generate(request);

    expect(response.text).toBe("Hello there");
    expect(response.toolCalls).toEqual([]);
  });

  it("leaves the model's private reasoning out of the reply text", async () => {
    const { fetchImpl } = stubFetch(() =>
      json(modelReply([{ text: "thinking about it", thought: true }, { text: "The limit is $75." }])),
    );

    expect((await client(fetchImpl).generate(request)).text).toBe("The limit is $75.");
  });

  it("returns tool calls with their ids and arguments", async () => {
    const { fetchImpl } = stubFetch(() =>
      json(
        modelReply([
          { functionCall: { name: "prepare_expense", args: { amount: 42 }, id: "call_9" }, thoughtSignature: "abc" },
          { functionCall: { name: "get_policy", args: {} } },
        ]),
      ),
    );

    const response = await client(fetchImpl).generate(request);

    expect(response.toolCalls).toEqual([
      { id: "call_9", name: "prepare_expense", args: { amount: 42 } },
      { id: undefined, name: "get_policy", args: {} },
    ]);
  });

  it("hands back the model's content untouched, signatures and unknown fields included", async () => {
    const content = {
      role: "model",
      parts: [
        { functionCall: { name: "get_policy", args: {}, id: "call_1" }, thoughtSignature: "c2ln", extra: [1, 2] },
      ],
    };
    const { fetchImpl } = stubFetch(() => json({ candidates: [{ content, finishReason: "STOP" }] }));

    expect((await client(fetchImpl).generate(request)).raw).toEqual(content);
  });
});

describe("Gemini client: failures", () => {
  async function failure(fetchImpl: typeof fetch, signal?: AbortSignal): Promise<LlmError> {
    const error = await client(fetchImpl)
      .generate({ ...request, signal })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LlmError);
    return error as LlmError;
  }

  it("reports HTTP 429 as rate limited and not worth retrying", async () => {
    const { fetchImpl } = stubFetch(() => json({ error: { message: "quota" } }, 429));
    expect(await failure(fetchImpl)).toMatchObject({ kind: "rate_limited", retryable: false, status: 429 });
  });

  it.each([500, 503])("reports HTTP %i as a retryable provider error", async (status) => {
    const { fetchImpl } = stubFetch(() => json({ error: { message: "boom" } }, status));
    expect(await failure(fetchImpl)).toMatchObject({ kind: "provider_error", retryable: true, status });
  });

  it.each([400, 401, 403, 404])("reports HTTP %i as a provider error that a retry will not fix", async (status) => {
    const { fetchImpl } = stubFetch(() => json({ error: { message: "bad" } }, status));
    expect(await failure(fetchImpl)).toMatchObject({ kind: "provider_error", retryable: false, status });
  });

  it("reports a network failure as retryable", async () => {
    const fetchImpl = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    expect(await failure(fetchImpl)).toMatchObject({ kind: "network", retryable: true });
  });

  it("reports an aborted request as a timeout", async () => {
    const fetchImpl = ((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
      })) as typeof fetch;

    expect(await failure(fetchImpl, AbortSignal.timeout(10))).toMatchObject({
      kind: "timeout",
      retryable: false,
    });
  });

  it.each<[string, () => Response]>([
    ["a body that is not JSON", () => new Response("<html>oops</html>", { status: 200 })],
    ["no candidates", () => json({ candidates: [] })],
    ["a candidate without content", () => json({ candidates: [{ finishReason: "STOP" }] })],
    ["empty parts", () => json(modelReply([]))],
    ["only blank text", () => json(modelReply([{ text: "  " }]))],
    ["a tool call without a name", () => json(modelReply([{ functionCall: { args: {} } }]))],
    [
      "a malformed function call",
      () => json({ candidates: [{ content: { role: "model", parts: [] }, finishReason: "MALFORMED_FUNCTION_CALL" }] }),
    ],
  ])("reports %s as an invalid response", async (_label, reply) => {
    const { fetchImpl } = stubFetch(reply);
    expect((await failure(fetchImpl)).kind).toBe("invalid_response");
  });

  it("reports a prompt blocked by safety filters", async () => {
    const { fetchImpl } = stubFetch(() => json({ promptFeedback: { blockReason: "SAFETY" } }));
    expect((await failure(fetchImpl)).kind).toBe("blocked");
  });

  it("never puts the API key or the provider's error text in the error message", async () => {
    const { fetchImpl } = stubFetch(() =>
      json({ error: { message: `API key ${API_KEY} is invalid` } }, 400),
    );

    const error = await failure(fetchImpl);

    expect(error.message).not.toContain(API_KEY);
    expect(JSON.stringify(error)).not.toContain(API_KEY);
  });
});

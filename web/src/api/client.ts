import type {
  ApiError,
  Bootstrap,
  Category,
  ExpenseDto,
  ExpenseStatus,
  PolicyCheckDto,
  PolicyDto,
  TurnResult,
} from "../../../shared/contract";

/**
 * Every call to the backend goes through here. The session lives in an
 * HttpOnly cookie that this code can neither read nor send by hand: the
 * browser attaches it because requests are same-origin.
 */

/** The model can take up to ~22 s on the server; this leaves room for the network. */
const TURN_TIMEOUT_MS = 40_000;
const QUICK_TIMEOUT_MS = 15_000;

export class RequestError extends Error {
  /** "network": no usable answer arrived, so the outcome is unknown. */
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 0) {
    super(message);
    this.name = "RequestError";
    this.code = code;
    this.status = status;
  }
}

async function request<T>(path: string, init: RequestInit, timeoutMs: number): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      credentials: "same-origin",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new RequestError("network", "The connection was lost before an answer arrived.");
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new RequestError("network", "The server sent an answer that could not be read.", response.status);
  }

  if (!response.ok) {
    const error = (body as Partial<ApiError>).error;
    throw new RequestError(
      error?.code ?? "unknown",
      error?.message ?? "Something went wrong.",
      response.status,
    );
  }
  return body as T;
}

const json = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

/**
 * Runs a call that needs a session. If the session is gone (cookie expired or
 * cleared), opens a new one and tries once more.
 */
async function withSession<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof RequestError && error.status === 401) {
      await openSession();
      return call();
    }
    throw error;
  }
}

export function openSession(): Promise<Bootstrap> {
  return request<Bootstrap>("/api/session", { method: "POST" }, QUICK_TIMEOUT_MS);
}

/** Clears the conversation on the server. Expenses and any draft are kept. */
export function resetConversation(): Promise<Bootstrap> {
  return withSession(() => request<Bootstrap>("/api/conversation/reset", { method: "POST" }, QUICK_TIMEOUT_MS));
}

export function sendChat(text: string): Promise<TurnResult> {
  return withSession(() => request<TurnResult>("/api/chat", json({ text }), TURN_TIMEOUT_MS));
}

export function sendReceipt(image: Blob, caption: string): Promise<TurnResult> {
  return withSession(() => {
    const form = new FormData();
    form.set("image", image, "receipt");
    if (caption) form.set("caption", caption);
    return request<TurnResult>("/api/receipts", { method: "POST", body: form }, TURN_TIMEOUT_MS);
  });
}

export function answerCurrency(currency: string): Promise<TurnResult> {
  return withSession(() =>
    request<TurnResult>("/api/receipts/pending/currency", json({ currency }), QUICK_TIMEOUT_MS),
  );
}

export function confirmExpense(id: number): Promise<TurnResult> {
  return withSession(() =>
    request<TurnResult>(`/api/expenses/${id}/confirm`, { method: "POST" }, QUICK_TIMEOUT_MS),
  );
}

export function cancelExpense(id: number): Promise<TurnResult> {
  return withSession(() =>
    request<TurnResult>(`/api/expenses/${id}/cancel`, { method: "POST" }, QUICK_TIMEOUT_MS),
  );
}

export function listExpenses(filters: { status: ExpenseStatus; category?: Category }): Promise<ExpenseDto[]> {
  const query = new URLSearchParams({ status: filters.status });
  if (filters.category) query.set("category", filters.category);
  return withSession(async () => {
    const body = await request<{ expenses: ExpenseDto[] }>(`/api/expenses?${query}`, {}, QUICK_TIMEOUT_MS);
    return body.expenses;
  });
}

export function getPolicy(): Promise<PolicyDto> {
  return withSession(() => request<PolicyDto>("/api/policy", {}, QUICK_TIMEOUT_MS));
}

export function checkPolicy(category: Category, amount: string): Promise<PolicyCheckDto> {
  const query = new URLSearchParams({ category, amount });
  return withSession(() => request<PolicyCheckDto>(`/api/policy/check?${query}`, {}, QUICK_TIMEOUT_MS));
}

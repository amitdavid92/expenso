/**
 * The small part of the Telegram Bot API this app uses, behind an interface so
 * tests can stand in for Telegram.
 *
 * Telegram puts the bot token in the URL of every request, including file
 * downloads. Nothing here ever logs a URL or passes one into an error: errors
 * carry the method name, a kind and an HTTP status, and nothing else.
 */

const API = "https://api.telegram.org";
const CALL_TIMEOUT_MS = 8_000;
const DOWNLOAD_TIMEOUT_MS = 8_000;

export type TelegramErrorKind = "rejected" | "network" | "timeout" | "too_large" | "bad_path";

export class TelegramError extends Error {
  readonly kind: TelegramErrorKind;
  readonly method: string;
  readonly status?: number;

  constructor(kind: TelegramErrorKind, method: string, status?: number) {
    super(`Telegram ${method} failed: ${kind}${status ? ` (HTTP ${status})` : ""}`);
    this.name = "TelegramError";
    this.kind = kind;
    this.method = method;
    this.status = status;
  }
}

export interface TelegramApi {
  /** Calls a Bot API method and returns its `result`. */
  call<T = unknown>(method: string, payload: Record<string, unknown>): Promise<T>;
  /** Downloads a file by the `file_path` that `getFile` returned. */
  download(filePath: string, maxBytes: number): Promise<Uint8Array>;
}

export function createTelegramApi(options: { token: string; fetch?: typeof fetch }): TelegramApi {
  const fetchImpl = options.fetch ?? fetch;

  /** Runs a request, turning every failure into a TelegramError that names no URL. */
  async function request(method: string, url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
    const signal = AbortSignal.timeout(timeoutMs);
    try {
      return await fetchImpl(url, { ...init, signal });
    } catch {
      // The underlying error's message can contain the URL, and with it the token.
      throw new TelegramError(signal.aborted ? "timeout" : "network", method);
    }
  }

  return {
    async call<T>(method: string, payload: Record<string, unknown>): Promise<T> {
      const response = await request(
        method,
        `${API}/bot${options.token}/${method}`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) },
        CALL_TIMEOUT_MS,
      );
      const body = (await response.json().catch(() => null)) as { ok?: boolean; result?: T } | null;
      if (!response.ok || !body?.ok) {
        // Telegram's `description` is not kept: it is not needed and may echo input.
        throw new TelegramError("rejected", method, response.status);
      }
      return body.result as T;
    },

    async download(filePath: string, maxBytes: number): Promise<Uint8Array> {
      // The path comes from Telegram, but it is still joined into a URL: keep it inside the bot's files.
      if (!/^[\w./-]+$/.test(filePath) || filePath.includes("..") || filePath.startsWith("/")) {
        throw new TelegramError("bad_path", "download");
      }
      const response = await request("download", `${API}/file/bot${options.token}/${filePath}`, {}, DOWNLOAD_TIMEOUT_MS);
      if (!response.ok) throw new TelegramError("rejected", "download", response.status);
      if (Number(response.headers.get("content-length") ?? 0) > maxBytes) {
        throw new TelegramError("too_large", "download");
      }
      const bytes = new Uint8Array(await response.arrayBuffer().catch(() => new ArrayBuffer(0)));
      if (bytes.length > maxBytes) throw new TelegramError("too_large", "download");
      return bytes;
    },
  };
}

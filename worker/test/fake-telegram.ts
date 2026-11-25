import { type TelegramApi, TelegramError } from "../src/adapters/telegram-api";

/** A tiny valid PNG signature, enough for the image checks. */
export const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

/** A stand-in for the Telegram Bot API that records every call. */
export class FakeTelegram implements TelegramApi {
  calls: { method: string; payload: Record<string, any> }[] = [];
  downloads: string[] = [];
  /** Methods that should fail, for failure tests. */
  failing = new Set<string>();
  file: Uint8Array = PNG;

  async call<T>(method: string, payload: Record<string, unknown>): Promise<T> {
    this.calls.push({ method, payload });
    if (this.failing.has(method)) throw new TelegramError("rejected", method, 400);
    if (method === "getFile") return { file_path: `photos/${payload.file_id}.jpg`, file_size: this.file.length } as T;
    return { message_id: 1000 + this.calls.length } as T;
  }

  async download(filePath: string): Promise<Uint8Array> {
    this.downloads.push(filePath);
    if (this.failing.has("download")) throw new TelegramError("network", "download");
    return this.file;
  }

  sent() {
    return this.calls.filter((c) => c.method === "sendMessage").map((c) => c.payload);
  }
  lastText(): string {
    return this.sent().at(-1)?.text ?? "";
  }
  buttons(): { text: string; callback_data?: string; url?: string }[] {
    return (this.sent().at(-1)?.reply_markup?.inline_keyboard ?? []).flat();
  }
  methods() {
    return this.calls.map((c) => c.method);
  }
}


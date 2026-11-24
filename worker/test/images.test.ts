import { describe, expect, it } from "vitest";
import { detectImageType, toBase64 } from "../src/lib/images";

const bytes = (...values: number[]) => new Uint8Array(values);
const ascii = (text: string) => new TextEncoder().encode(text);

describe("detectImageType", () => {
  it("recognises a JPEG by its first bytes", () => {
    expect(detectImageType(bytes(0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46))).toBe("image/jpeg");
  });

  it("recognises a PNG by its first bytes", () => {
    expect(detectImageType(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00))).toBe("image/png");
  });

  it.each<[string, Uint8Array]>([
    ["a GIF", ascii("GIF89a......")],
    ["a WebP", ascii("RIFF....WEBPVP8 ")],
    ["a PDF", ascii("%PDF-1.7 ....")],
    ["plain text", ascii("this is not an image")],
    ["an HTML page", ascii("<html><body>receipt</body></html>")],
    ["an SVG", ascii('<svg xmlns="http://www.w3.org/2000/svg"/>')],
    ["an empty file", bytes()],
    ["a file cut off inside the PNG signature", bytes(0x89, 0x50, 0x4e, 0x47)],
    ["a file cut off inside the JPEG signature", bytes(0xff, 0xd8)],
  ])("rejects %s", (_label, data) => {
    expect(detectImageType(data)).toBeNull();
  });
});

describe("toBase64", () => {
  it("encodes bytes as standard base64", () => {
    expect(toBase64(ascii("receipt"))).toBe("cmVjZWlwdA==");
  });

  it("round-trips a large binary buffer", () => {
    const data = new Uint8Array(300_000).map((_, i) => (i * 31) % 256);
    const decoded = Uint8Array.from(atob(toBase64(data)), (c) => c.charCodeAt(0));
    expect(decoded).toEqual(data);
  });
});

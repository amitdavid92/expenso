/** The only image formats accepted for receipts. */
export type ImageType = "image/jpeg" | "image/png";

/**
 * Receipts are photos of small pieces of paper; 4 MB is generous for that and
 * keeps the base64 copy sent to the model well inside the Worker's memory and
 * the provider's 20 MB request limit.
 */
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_SIGNATURE = [0xff, 0xd8, 0xff];

function startsWith(bytes: Uint8Array, signature: number[]): boolean {
  return bytes.length >= signature.length && signature.every((value, i) => bytes[i] === value);
}

/**
 * Identifies the format from the file's own first bytes. The file name and the
 * content type a client claims are never trusted.
 */
export function detectImageType(bytes: Uint8Array): ImageType | null {
  if (startsWith(bytes, PNG_SIGNATURE)) return "image/png";
  if (startsWith(bytes, JPEG_SIGNATURE)) return "image/jpeg";
  return null;
}

export function toBase64(bytes: Uint8Array): string {
  // Built in chunks: String.fromCharCode cannot take millions of arguments at once.
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

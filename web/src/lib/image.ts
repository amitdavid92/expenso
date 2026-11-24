/** Longest side sent to the server. Plenty to read a receipt; far smaller than a phone photo. */
const MAX_SIDE = 1600;
/** Files already this small, in a format the server accepts, are sent untouched. */
const SMALL_ENOUGH = 1.5 * 1024 * 1024;

/**
 * Prepares a photo for upload: scaled down and re-encoded as JPEG in the
 * browser. Phone photos are commonly 3–8 MB (over the server's limit) and
 * iPhones produce HEIC; this handles both.
 *
 * It is a convenience, not a safeguard: the server checks the real format and
 * size of whatever arrives. If the browser cannot decode the file, the
 * original is sent and the server gives the verdict.
 */
export async function prepareImage(file: Blob): Promise<Blob> {
  const accepted = file.type === "image/jpeg" || file.type === "image/png";
  if (accepted && file.size <= SMALL_ENOUGH) return file;

  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    const context = canvas.getContext("2d");
    if (!context) return file;
    // Transparent pixels would turn black in a JPEG; receipts are on white.
    context.fillStyle = "#fff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();

    const jpeg = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.85));
    return jpeg ?? file;
  } catch {
    return file;
  }
}

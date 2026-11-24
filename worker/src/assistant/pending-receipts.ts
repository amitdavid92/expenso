import type { ReceiptAnalysis } from "./types";

/**
 * A receipt that was read only in part waits here, as structured data, until
 * the user supplies the rest. One per user. It is removed when a draft is
 * created (inside `createDraft`), so it can never outlive the expense it became.
 * Only extracted fields are kept; the image never is.
 */

export async function getPendingReceipt(db: D1Database, userId: number): Promise<ReceiptAnalysis | null> {
  const row = await db
    .prepare("SELECT analysis FROM pending_receipts WHERE user_id = ?")
    .bind(userId)
    .first<{ analysis: string }>();
  return row ? (JSON.parse(row.analysis) as ReceiptAnalysis) : null;
}

export async function savePendingReceipt(
  db: D1Database,
  userId: number,
  analysis: ReceiptAnalysis,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO pending_receipts (user_id, analysis, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT (user_id) DO UPDATE SET analysis = excluded.analysis, updated_at = excluded.updated_at`,
    )
    .bind(userId, JSON.stringify(analysis))
    .run();
}

/** Returns true if there was one to remove. */
export async function clearPendingReceipt(db: D1Database, userId: number): Promise<boolean> {
  const result = await db.prepare("DELETE FROM pending_receipts WHERE user_id = ?").bind(userId).run();
  return result.meta.changes > 0;
}

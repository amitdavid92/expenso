import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

async function createUser(externalId: string): Promise<number> {
  const row = await env.DB.prepare(
    "INSERT INTO users (channel, external_id) VALUES ('web', ?) RETURNING id",
  )
    .bind(externalId)
    .first<{ id: number }>();
  return row!.id;
}

function insertExpense(userId: number, status: string) {
  return env.DB.prepare(
    `INSERT INTO expenses (user_id, amount_cents, category, merchant, expense_date, status, policy_result)
     VALUES (?, 4200, 'meals', 'Cafe Nero', '2026-11-20', ?, 'within_policy')`,
  )
    .bind(userId, status)
    .run();
}

describe("database schema", () => {
  it("creates every table from the migration", async () => {
    const { results } = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    ).all<{ name: string }>();

    expect(results.map((r) => r.name)).toEqual(
      expect.arrayContaining(["expenses", "messages", "telegram_updates", "usage_daily", "users"]),
    );
  });

  it("rejects a second active draft for the same user", async () => {
    const userId = await createUser("schema-one-draft");
    await insertExpense(userId, "draft");

    await expect(insertExpense(userId, "draft")).rejects.toThrow(/UNIQUE/i);
  });

  it("allows a new draft once the previous one is submitted, and drafts for other users", async () => {
    const userA = await createUser("schema-user-a");
    const userB = await createUser("schema-user-b");
    await insertExpense(userA, "draft");
    await insertExpense(userB, "draft");

    await env.DB.prepare("UPDATE expenses SET status = 'submitted' WHERE user_id = ?")
      .bind(userA)
      .run();
    await insertExpense(userA, "draft");

    const count = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM expenses WHERE user_id = ?",
    )
      .bind(userA)
      .first<{ n: number }>();
    expect(count!.n).toBe(2);
  });

  it("does not link the same external id across channels", async () => {
    await env.DB.prepare("INSERT INTO users (channel, external_id) VALUES ('web', '12345')").run();
    await env.DB.prepare("INSERT INTO users (channel, external_id) VALUES ('telegram', '12345')").run();

    await expect(
      env.DB.prepare("INSERT INTO users (channel, external_id) VALUES ('telegram', '12345')").run(),
    ).rejects.toThrow(/UNIQUE/i);
  });
});

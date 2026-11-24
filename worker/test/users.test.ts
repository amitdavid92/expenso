import { describe, expect, it } from "vitest";
import { ValidationError } from "../src/lib/errors";
import { findOrCreateUser, findUser } from "../src/services/users";
import { db } from "./helpers";

describe("findOrCreateUser", () => {
  it("creates a user the first time and returns the same user afterwards", async () => {
    const externalId = crypto.randomUUID();

    const first = await findOrCreateUser(db, { channel: "telegram", externalId, displayName: "Dana" });
    const second = await findOrCreateUser(db, { channel: "telegram", externalId });

    expect(first).toMatchObject({ channel: "telegram", externalId, displayName: "Dana" });
    expect(second.id).toBe(first.id);
    expect(second.displayName).toBe("Dana");
  });

  it("keeps web and Telegram users separate even when their external ids match", async () => {
    const externalId = crypto.randomUUID();

    const web = await findOrCreateUser(db, { channel: "web", externalId });
    const telegram = await findOrCreateUser(db, { channel: "telegram", externalId });

    expect(web.id).not.toBe(telegram.id);
  });

  it("updates the display name when a newer one is supplied", async () => {
    const externalId = crypto.randomUUID();
    await findOrCreateUser(db, { channel: "telegram", externalId, displayName: "Old" });

    const updated = await findOrCreateUser(db, { channel: "telegram", externalId, displayName: "New" });

    expect(updated.displayName).toBe("New");
  });

  it("creates exactly one user when called concurrently for the same identity", async () => {
    const externalId = crypto.randomUUID();

    const users = await Promise.all(
      Array.from({ length: 10 }, () => findOrCreateUser(db, { channel: "web", externalId })),
    );

    expect(new Set(users.map((u) => u.id)).size).toBe(1);
  });

  it.each([
    ["an unknown channel", { channel: "sms", externalId: "abc" }],
    ["an empty external id", { channel: "web", externalId: "" }],
    ["a blank external id", { channel: "web", externalId: "   " }],
    ["an oversized external id", { channel: "web", externalId: "x".repeat(129) }],
    ["a non-string external id", { channel: "web", externalId: 42 }],
  ])("rejects %s", async (_label, input) => {
    await expect(findOrCreateUser(db, input as never)).rejects.toThrow(ValidationError);
  });
});

describe("findUser", () => {
  it("returns null for an identity that was never created", async () => {
    expect(await findUser(db, "web", crypto.randomUUID())).toBeNull();
  });

  it("does not find a web user through the Telegram channel", async () => {
    const externalId = crypto.randomUUID();
    await findOrCreateUser(db, { channel: "web", externalId });

    expect(await findUser(db, "telegram", externalId)).toBeNull();
    expect(await findUser(db, "web", externalId)).not.toBeNull();
  });
});

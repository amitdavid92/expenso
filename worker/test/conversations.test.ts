import { describe, expect, it } from "vitest";
import { ValidationError } from "../src/lib/errors";
import {
  MAX_MESSAGE_LENGTH,
  appendMessage,
  listRecentMessages,
} from "../src/services/conversations";
import { db, newUser } from "./helpers";

describe("conversations", () => {
  it("returns messages oldest first", async () => {
    const user = await newUser();
    await appendMessage(db, user.id, "user", "I spent $42 on lunch");
    await appendMessage(db, user.id, "assistant", "Got it. Which restaurant?");
    await appendMessage(db, user.id, "user", "Cafe Nero");

    const messages = await listRecentMessages(db, user.id);

    expect(messages.map((m) => [m.role, m.content])).toEqual([
      ["user", "I spent $42 on lunch"],
      ["assistant", "Got it. Which restaurant?"],
      ["user", "Cafe Nero"],
    ]);
  });

  it("keeps only the most recent messages when a limit is given, still oldest first", async () => {
    const user = await newUser();
    for (const text of ["one", "two", "three", "four"]) {
      await appendMessage(db, user.id, "user", text);
    }

    const messages = await listRecentMessages(db, user.id, 2);

    expect(messages.map((m) => m.content)).toEqual(["three", "four"]);
  });

  it("never returns another user's messages", async () => {
    const alice = await newUser();
    const bob = await newUser("telegram");
    await appendMessage(db, alice.id, "user", "alice's secret dinner");
    await appendMessage(db, bob.id, "user", "bob's taxi");

    expect((await listRecentMessages(db, alice.id)).map((m) => m.content)).toEqual([
      "alice's secret dinner",
    ]);
    expect((await listRecentMessages(db, bob.id)).map((m) => m.content)).toEqual(["bob's taxi"]);
  });

  it("returns an empty history for a new user", async () => {
    const user = await newUser();
    expect(await listRecentMessages(db, user.id)).toEqual([]);
  });

  it("accepts a message exactly at the maximum length", async () => {
    const user = await newUser();
    const message = await appendMessage(db, user.id, "user", "x".repeat(MAX_MESSAGE_LENGTH));
    expect(message.content).toHaveLength(MAX_MESSAGE_LENGTH);
  });

  it.each([
    ["an empty message", "user", ""],
    ["a whitespace-only message", "user", "  \n "],
    ["a message over the maximum length", "user", "x".repeat(MAX_MESSAGE_LENGTH + 1)],
    ["an unknown role", "system", "hello"],
    ["non-text content", "user", 123],
  ])("rejects %s", async (_label, role, content) => {
    const user = await newUser();
    await expect(appendMessage(db, user.id, role as never, content as never)).rejects.toThrow(
      ValidationError,
    );
  });

  it.each([0, -1, 1.5, 101])("rejects a limit of %s", async (limit) => {
    const user = await newUser();
    await expect(listRecentMessages(db, user.id, limit)).rejects.toThrow(ValidationError);
  });
});

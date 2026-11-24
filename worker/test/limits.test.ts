import { describe, expect, it } from "vitest";
import { ValidationError } from "../src/lib/errors";
import { consumeQuota } from "../src/services/limits";
import { db, newUser } from "./helpers";

// Each test uses its own calendar day so the shared application counter starts at zero.
const day = (iso: string) => new Date(`${iso}T12:00:00Z`);

describe("consumeQuota", () => {
  it("allows requests up to the per-user limit and reports what is left", async () => {
    const user = await newUser();
    const opts = { userId: user.id, userDailyLimit: 3, appDailyLimit: 100, now: day("2031-01-01") };

    expect(await consumeQuota(db, opts)).toEqual({ allowed: true, userRemaining: 2, appRemaining: 99 });
    expect(await consumeQuota(db, opts)).toEqual({ allowed: true, userRemaining: 1, appRemaining: 98 });
    expect(await consumeQuota(db, opts)).toEqual({ allowed: true, userRemaining: 0, appRemaining: 97 });
  });

  it("refuses the request after the per-user limit is reached", async () => {
    const user = await newUser();
    const opts = { userId: user.id, userDailyLimit: 2, appDailyLimit: 100, now: day("2031-01-02") };
    await consumeQuota(db, opts);
    await consumeQuota(db, opts);

    expect(await consumeQuota(db, opts)).toEqual({ allowed: false, exhausted: "user" });
  });

  it("gives every user their own allowance", async () => {
    const alice = await newUser();
    const bob = await newUser();
    const base = { userDailyLimit: 1, appDailyLimit: 100, now: day("2031-01-03") };
    await consumeQuota(db, { ...base, userId: alice.id });

    expect((await consumeQuota(db, { ...base, userId: alice.id })).allowed).toBe(false);
    expect((await consumeQuota(db, { ...base, userId: bob.id })).allowed).toBe(true);
  });

  it("refuses everyone once the application-wide limit is reached", async () => {
    const alice = await newUser();
    const bob = await newUser();
    const carol = await newUser();
    const base = { userDailyLimit: 10, appDailyLimit: 2, now: day("2031-01-04") };
    await consumeQuota(db, { ...base, userId: alice.id });
    await consumeQuota(db, { ...base, userId: bob.id });

    expect(await consumeQuota(db, { ...base, userId: carol.id })).toEqual({
      allowed: false,
      exhausted: "app",
    });
  });

  it("does not charge the user when the application-wide limit refuses the request", async () => {
    const alice = await newUser();
    const bob = await newUser();
    const now = day("2031-01-05");
    await consumeQuota(db, { userId: alice.id, userDailyLimit: 5, appDailyLimit: 1, now });
    await consumeQuota(db, { userId: bob.id, userDailyLimit: 5, appDailyLimit: 1, now }); // refused

    // With a higher application limit Bob still has his full allowance.
    expect(await consumeQuota(db, { userId: bob.id, userDailyLimit: 5, appDailyLimit: 10, now })).toEqual({
      allowed: true,
      userRemaining: 4,
      appRemaining: 8,
    });
  });

  it("does not charge the application when the per-user limit refuses the request", async () => {
    const alice = await newUser();
    const bob = await newUser();
    const base = { userDailyLimit: 1, appDailyLimit: 3, now: day("2031-01-06") };
    await consumeQuota(db, { ...base, userId: alice.id });
    await consumeQuota(db, { ...base, userId: alice.id }); // refused
    await consumeQuota(db, { ...base, userId: alice.id }); // refused

    expect(await consumeQuota(db, { ...base, userId: bob.id })).toEqual({
      allowed: true,
      userRemaining: 0,
      appRemaining: 1,
    });
  });

  it("starts fresh on the next UTC day", async () => {
    const user = await newUser();
    const base = { userId: user.id, userDailyLimit: 1, appDailyLimit: 1 };
    await consumeQuota(db, { ...base, now: new Date("2031-01-07T23:59:59Z") });

    expect((await consumeQuota(db, { ...base, now: new Date("2031-01-07T23:59:59Z") })).allowed).toBe(false);
    expect((await consumeQuota(db, { ...base, now: new Date("2031-01-08T00:00:00Z") })).allowed).toBe(true);
  });

  it("never lets concurrent requests exceed the per-user limit", async () => {
    const user = await newUser();
    const opts = { userId: user.id, userDailyLimit: 5, appDailyLimit: 1000, now: day("2031-01-09") };

    const results = await Promise.all(Array.from({ length: 20 }, () => consumeQuota(db, opts)));

    expect(results.filter((r) => r.allowed)).toHaveLength(5);
  });

  it("never lets concurrent requests from many users exceed the application limit", async () => {
    const users = await Promise.all(Array.from({ length: 20 }, () => newUser()));
    const base = { userDailyLimit: 5, appDailyLimit: 7, now: day("2031-01-10") };

    const results = await Promise.all(users.map((u) => consumeQuota(db, { ...base, userId: u.id })));

    expect(results.filter((r) => r.allowed)).toHaveLength(7);
  });

  it("refuses everything when a limit is zero", async () => {
    const user = await newUser();
    const now = day("2031-01-11");

    expect(await consumeQuota(db, { userId: user.id, userDailyLimit: 0, appDailyLimit: 10, now })).toEqual({
      allowed: false,
      exhausted: "user",
    });
    expect(await consumeQuota(db, { userId: user.id, userDailyLimit: 10, appDailyLimit: 0, now })).toEqual({
      allowed: false,
      exhausted: "app",
    });
  });

  it.each([-1, 1.5, Number.NaN])("rejects an invalid limit of %s", async (limit) => {
    const user = await newUser();
    await expect(
      consumeQuota(db, { userId: user.id, userDailyLimit: limit, appDailyLimit: 10 }),
    ).rejects.toThrow(ValidationError);
  });
});

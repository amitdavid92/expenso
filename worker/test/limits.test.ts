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

  // Gemini's daily quota resets at midnight Pacific time, so our counters do too.
  it("starts fresh at midnight Pacific time in winter (08:00 UTC), not at midnight UTC", async () => {
    const user = await newUser();
    const base = { userId: user.id, userDailyLimit: 1, appDailyLimit: 1 };
    await consumeQuota(db, { ...base, now: new Date("2031-01-07T20:00:00Z") });

    expect((await consumeQuota(db, { ...base, now: new Date("2031-01-08T00:30:00Z") })).allowed).toBe(false);
    expect((await consumeQuota(db, { ...base, now: new Date("2031-01-08T07:59:59Z") })).allowed).toBe(false);
    expect((await consumeQuota(db, { ...base, now: new Date("2031-01-08T08:00:00Z") })).allowed).toBe(true);
  });

  it("starts fresh at midnight Pacific time in summer (07:00 UTC)", async () => {
    const user = await newUser();
    const base = { userId: user.id, userDailyLimit: 1, appDailyLimit: 1 };
    await consumeQuota(db, { ...base, now: new Date("2031-07-07T20:00:00Z") });

    expect((await consumeQuota(db, { ...base, now: new Date("2031-07-08T06:59:59Z") })).allowed).toBe(false);
    expect((await consumeQuota(db, { ...base, now: new Date("2031-07-08T07:00:00Z") })).allowed).toBe(true);
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

describe("consumeQuota: requests per minute", () => {
  const at = (iso: string) => new Date(iso);
  const base = { userDailyLimit: 1000, appDailyLimit: 1000, appPerMinuteLimit: 3 };

  it("allows the configured number of requests within a minute, then refuses", async () => {
    const user = await newUser();
    const now = at("2032-03-01T12:00:00Z");
    for (let i = 0; i < 3; i++) {
      expect((await consumeQuota(db, { ...base, userId: user.id, now })).allowed).toBe(true);
    }

    expect(await consumeQuota(db, { ...base, userId: user.id, now })).toEqual({
      allowed: false,
      exhausted: "minute",
    });
  });

  it("applies to the whole application, across users", async () => {
    const users = await Promise.all([newUser(), newUser(), newUser(), newUser()]);
    const now = at("2032-03-02T12:00:00Z");
    const results = [];
    for (const user of users) results.push(await consumeQuota(db, { ...base, userId: user.id, now }));

    expect(results.map((r) => r.allowed)).toEqual([true, true, true, false]);
  });

  it("is a rolling window: a slot frees up exactly 60 seconds after the request that used it", async () => {
    const user = await newUser();
    const request = (iso: string) => consumeQuota(db, { ...base, userId: user.id, now: at(iso) });
    await request("2032-03-03T12:00:00.000Z");
    await request("2032-03-03T12:00:20.000Z");
    await request("2032-03-03T12:00:40.000Z");

    expect((await request("2032-03-03T12:00:59.999Z")).allowed).toBe(false);
    expect((await request("2032-03-03T12:01:00.000Z")).allowed).toBe(true); // the 12:00:00 slot is free
    expect((await request("2032-03-03T12:01:10.000Z")).allowed).toBe(false); // 12:00:20 is still inside
    expect((await request("2032-03-03T12:01:20.000Z")).allowed).toBe(true);
  });

  it("does not charge the daily allowances when the minute limit refuses", async () => {
    const user = await newUser();
    const now = at("2032-03-04T12:00:00Z");
    const tight = { ...base, userDailyLimit: 10, userId: user.id };
    for (let i = 0; i < 5; i++) await consumeQuota(db, { ...tight, now }); // 3 allowed, 2 refused

    const later = await consumeQuota(db, { ...tight, now: at("2032-03-04T12:05:00Z") });

    expect(later).toMatchObject({ allowed: true, userRemaining: 6 });
  });

  it("does not use up a minute slot when a daily limit refuses", async () => {
    const blocked = await newUser();
    const other = await newUser();
    const now = at("2032-03-05T12:00:00Z");
    for (let i = 0; i < 5; i++) {
      await consumeQuota(db, { ...base, userDailyLimit: 0, userId: blocked.id, now });
      await consumeQuota(db, { ...base, userDailyLimit: 1, userId: blocked.id, now });
    }

    // "blocked" got 1 through and was refused 9 times; 2 of the 3 slots must still be free.
    expect((await consumeQuota(db, { ...base, userId: other.id, now })).allowed).toBe(true);
    expect((await consumeQuota(db, { ...base, userId: other.id, now })).allowed).toBe(true);
    expect((await consumeQuota(db, { ...base, userId: other.id, now })).allowed).toBe(false);
  });

  it("never lets concurrent requests exceed the per-minute limit", async () => {
    const users = await Promise.all(Array.from({ length: 20 }, () => newUser()));
    const now = at("2032-03-06T12:00:00Z");

    const results = await Promise.all(
      users.map((u) => consumeQuota(db, { ...base, appPerMinuteLimit: 12, userId: u.id, now })),
    );

    expect(results.filter((r) => r.allowed)).toHaveLength(12);
  });

  it("refuses everything when the per-minute limit is zero", async () => {
    const user = await newUser();
    expect(
      await consumeQuota(db, { ...base, appPerMinuteLimit: 0, userId: user.id, now: at("2032-03-07T12:00:00Z") }),
    ).toEqual({ allowed: false, exhausted: "minute" });
  });

  it("rejects an invalid per-minute limit", async () => {
    const user = await newUser();
    await expect(consumeQuota(db, { ...base, appPerMinuteLimit: -1, userId: user.id })).rejects.toThrow(ValidationError);
  });
});

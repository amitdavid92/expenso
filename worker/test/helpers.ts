import { env } from "cloudflare:test";
import { findOrCreateUser } from "../src/services/users";

export const db = env.DB;

/** A brand-new user, so tests never depend on each other's data. */
export async function newUser(channel: "web" | "telegram" = "web") {
  return findOrCreateUser(db, { channel, externalId: crypto.randomUUID() });
}

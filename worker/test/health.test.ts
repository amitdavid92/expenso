import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import app from "../src/index";

describe("GET /api/health", () => {
  it("reports ok when the database is reachable", async () => {
    const res = await app.request("/api/health", {}, env);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok", database: "ok" });
  });

  it("returns the standard error shape for unknown API routes", async () => {
    const res = await app.request("/api/does-not-exist", {}, env);

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: { code: "not_found", message: "Route not found" },
    });
  });
});

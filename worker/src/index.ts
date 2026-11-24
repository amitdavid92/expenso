import { Hono } from "hono";

const app = new Hono<{ Bindings: Env }>();

/** Liveness check. Also proves the D1 binding is reachable. */
app.get("/api/health", async (c) => {
  try {
    await c.env.DB.prepare("SELECT 1").first();
    return c.json({ status: "ok", database: "ok" });
  } catch {
    return c.json({ status: "degraded", database: "unreachable" }, 503);
  }
});

app.notFound((c) =>
  c.json({ error: { code: "not_found", message: "Route not found" } }, 404),
);

app.onError((err, c) => {
  console.error(err);
  return c.json(
    { error: { code: "internal_error", message: "Something went wrong" } },
    500,
  );
});

export default app;

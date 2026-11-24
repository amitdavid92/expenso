import { useEffect, useState } from "react";

type Health =
  | { state: "loading" }
  | { state: "ok" }
  | { state: "error"; message: string };

/** Phase 0 placeholder: proves the web app can reach the Worker API. */
export default function App() {
  const [health, setHealth] = useState<Health>({ state: "loading" });

  useEffect(() => {
    fetch("/api/health")
      .then(async (res) => {
        const body = (await res.json()) as { status?: string };
        if (res.ok && body.status === "ok") setHealth({ state: "ok" });
        else setHealth({ state: "error", message: `API responded ${res.status}` });
      })
      .catch(() => setHealth({ state: "error", message: "API unreachable" }));
  }, []);

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-50 p-6">
      <div className="w-full max-w-sm rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <h1 className="text-xl font-semibold text-slate-900">Expenso</h1>
        <p className="mt-1 text-sm text-slate-500">AI expense assistant</p>
        <p className="mt-4 text-sm" role="status">
          {health.state === "loading" && <span className="text-slate-500">Checking API…</span>}
          {health.state === "ok" && <span className="text-emerald-700">API connected</span>}
          {health.state === "error" && <span className="text-red-700">{health.message}</span>}
        </p>
      </div>
    </main>
  );
}

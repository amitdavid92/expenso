# Expenso

An AI-powered business expense assistant, reachable from a web chat and from Telegram.
Home assignment for a Full Stack Engineer position. All expense data and company
policies are fictional.

> **Status:** work in progress. The project scaffold and the deterministic backend
> services (policy, expenses, users, conversations, rate limits) are in place.
> The assistant (Gemini), the Telegram integration and the chat UI are not built yet.

## Stack

| Part | Technology |
|---|---|
| Backend | TypeScript, Hono, Cloudflare Workers |
| Database | Cloudflare D1 (SQLite) |
| Frontend | React, TypeScript, Vite, Tailwind CSS |
| Tests | Vitest, running inside the local Workers runtime |

Everything runs locally and on free tiers. No paid billing is needed.

## Local setup

Requires Node.js 22.12 or newer and npm.

```bash
npm install
npm run db:migrate:local      # creates the local D1 database
```

Secrets are **not needed yet**: nothing in the current code reads them. When they are,
copy the template and fill it in:

```bash
cp .env.example worker/.dev.vars
```

`worker/.dev.vars` is git-ignored. Never commit real values.

## Verifying the setup

```bash
npm run typecheck             # both workspaces
npm test                      # backend tests against a local, throwaway D1
npm run build                 # builds the web app into web/dist
```

Then run the two dev servers in separate terminals:

```bash
npm run dev:worker            # API on http://localhost:8787
npm run dev:web               # web app on http://localhost:5173 (proxies /api to the worker)
```

- `http://localhost:5173` should show "API connected".
- `curl http://localhost:8787/api/health` should return `{"status":"ok","database":"ok"}`.
- `http://localhost:8787` serves the built web app from the Worker, as production will.

## Project layout

```
worker/
  migrations/        D1 schema
  src/index.ts       Hono app (routes)
  src/services/      deterministic business logic: policy, expenses, users, conversations, limits
  src/lib/           money, dates, validation errors
  test/              Vitest tests
web/                 React app
```

## Rules the backend enforces

- Money is stored as whole cents. Only USD is supported.
- Company policy is evaluated by code, never by the language model.
- An expense starts as a **draft** and is only **submitted** by an explicit confirmation
  that names that draft. Submission does not mean approval: an expense over its
  category limit is submitted and marked `needs_review`.
- A user has at most one draft. This is enforced by a unique index in the database.
- Confirm and cancel are atomic and safe to repeat; an outdated draft id is refused.
- Every query is scoped to one user. Web and Telegram users are never linked.
- Daily usage limits, per user and for the whole application, protect the free Gemini quota.

## Known limitations

- Dates are evaluated in UTC. Shortly after midnight in a timezone ahead of UTC,
  "today" can still be yesterday in UTC, so an expense dated today may be reported as
  being in the future.
- Policy is checked when a draft is created, not again at confirmation.
- `wrangler` 4 and `@cloudflare/vitest-plugin` currently ship a beta build of Miniflare
  (the local Workers simulator, `5.x-beta`). It is a development-only dependency and has
  been stable here. If it causes trouble, the fallback is to pin `wrangler` to the last
  release that bundles a stable Miniflare.

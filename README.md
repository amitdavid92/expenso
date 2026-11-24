# Expenso

**Snap. Chat. Submit.** An AI-powered business expense assistant: photograph a receipt or
describe an expense, correct it in conversation, and submit it with an explicit confirmation.
It will be reachable from a web chat and from Telegram.
Home assignment for a Full Stack Engineer position. All expense data and company
policies are fictional.

> **Status:** work in progress. The deterministic backend services, the AI assistant
> (Gemini with tool calling) and receipt photo analysis are in place and can be used from a
> terminal. Still to come: the web experience (Phase 4), Telegram with photos (Phase 5),
> cross-channel continuity (Phase 6), deployment and demo (Phase 7).

## Stack

| Part | Technology |
|---|---|
| Backend | TypeScript, Hono, Cloudflare Workers |
| Database | Cloudflare D1 (SQLite) |
| Language model | Google Gemini (`gemini-3.5-flash-lite`, free tier): tool calling and image input |
| Frontend | React, TypeScript, Vite, Tailwind CSS |
| Tests | Vitest, running inside the local Workers runtime |

Everything runs locally and on free tiers. No paid billing is needed.

## Local setup

Requires Node.js 22.12 or newer and npm.

```bash
npm install
npm run db:migrate:local      # creates the local D1 database
```

Type checking, tests and the build need no secrets. To talk to the real model, copy the
template and fill in `GEMINI_API_KEY` (a free key from Google AI Studio, no billing):

```bash
cp .env.example worker/.dev.vars
```

`worker/.dev.vars` is git-ignored. Never commit real values.

## Talking to the assistant locally

```bash
npm run chat                      # interactive; Ctrl+D to quit
npm run chat -- --user dana       # a named user; each name has its own history and expenses
npm run chat -- --new             # a brand-new user
```

This calls the shared assistant directly, with the real Gemini model and the local
database. Try:

```
I spent $42 on lunch at Cafe Nero yesterday
Actually make it $45
confirm
How much have I spent this month?
```

To try receipt analysis, send one of the fictional sample images from inside the chat
(paths are relative to the `worker` folder; any JPEG or PNG of your own works too):

```
/receipt samples/receipt-cafe-aurora.png
The total was actually $52 with the tip
confirm
/receipt samples/receipt-euro.png
/receipt samples/receipt-blurry.png
/receipt samples/not-a-receipt.png
```

Each line of output ends with the time taken and, if relevant, the error code, the receipt
result and the pending draft. Every model request counts against the limits below.

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
  src/assistant/     the channel-independent assistant: chat, receipt analysis, tools, prompt
  src/llm/           LlmClient interface and the Gemini implementation
  src/services/      deterministic business logic: policy, expenses, users, conversations, limits
  scripts/chat.ts    terminal chat for local testing
  samples/           fictional receipt images for testing
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
- Policy is checked when a draft is created and again when it is confirmed, so a draft
  that became too old while waiting cannot be submitted.
- Every query is scoped to one user. Web and Telegram users are never linked.
- Daily usage limits, per user and for the whole application, protect the free Gemini quota.

## How the assistant works

The model decides what the user means; code decides what is allowed and what happens.

- **Tools.** The model can call `get_policy`, `prepare_expense`, `cancel_draft`,
  `list_expenses` and `get_spending_summary`. Every argument is validated, and the user
  id is supplied by the backend, never by the model.
- **No submit tool.** The model can only save a draft. An expense is submitted when the
  user types `confirm` (or presses a Confirm button, once the UIs exist). That path does
  not involve the model at all. "yes" or "ok" is not a confirmation.
- **Truthful status.** Whenever a draft is saved or submitted, the status text shown to
  the user is written by code from the database. If the model's own text claims a
  submission, it is replaced.
- **Bounded work.** One user message can cause at most five model requests, each limited
  to 8 seconds, all within 22 seconds. Failed requests worth retrying (network errors,
  HTTP 5xx, hangs) are retried up to twice after a short pause. Tools only run after a
  successful response, so a retry never repeats a change.
- **Model metadata.** While a turn is in progress, the model's output is sent back to it
  exactly as received. Gemini 3 and later reject a request if a function call returns
  without the thought signature it was issued with.

### Receipt photos

`handleReceipt` takes the image bytes and an optional caption; it is the same call for
every channel.

1. The file's own first bytes must identify it as JPEG or PNG, and it must be at most 4 MB.
   Anything else is refused before the model is called or quota is used.
2. One model request transcribes the receipt into a fixed JSON shape: merchant, total,
   currency, date, suggested category, short description, and whether the image is a
   receipt at all. The model is told to return `null` for anything it cannot read.
3. Code validates every field on its own. A value that is absent, of the wrong type or out
   of range is treated as missing, never used.
4. If everything required is present and in USD, the normal policy check runs and the
   expense is saved as a **draft**. Otherwise the reply says exactly which fields are
   missing, or that the currency is unsupported, or why policy blocks it.
5. What was read is written into the conversation, so the next message ("it was
   yesterday", "the total was actually $52") continues from it.

Safeguards:

- The image is untrusted. The extraction request has no tools and no conversation
  history, so text printed on a receipt cannot trigger an action or see other data;
  extracted text is flattened to one bounded line before it is shown or reused.
- A receipt is never submitted automatically. It becomes a draft that the user confirms.
- The image is not stored. It is sent to the model and dropped; the conversation keeps
  only the placeholder `[Receipt photo]`. Nothing about the image is logged.
- Receipt analysis goes through the same quota, timeout and retry handling as chat.

### Model and quota

| Setting | Value | Where |
|---|---|---|
| `GEMINI_MODEL` | `gemini-3.5-flash-lite` | `worker/wrangler.jsonc` |
| `USER_DAILY_LLM_LIMIT` | 60 model requests per user per day | `worker/wrangler.jsonc` |
| `APP_DAILY_LLM_LIMIT` | 400 model requests per day in total | `worker/wrangler.jsonc` |
| `APP_PER_MINUTE_LLM_LIMIT` | 12 model requests in any 60 seconds, in total | `worker/wrangler.jsonc` |

- The model is stable, free of charge on Gemini's free tier, and supports function calling,
  image input and structured JSON output.
- Its free-tier quota, checked in Google AI Studio for this project (November 2026), is
  15 requests per minute, 250,000 tokens per minute and 500 requests per day. The limits
  above sit below that, leaving room for requests made outside the app.
- Every model request counts: first attempts, tool-calling rounds, retries and receipt
  extractions. A chat message that uses a tool takes two or more.
- Daily counters reset at midnight US Pacific time, the same moment Gemini's daily quota
  resets. The per-minute limit is a rolling 60-second window.
- If Google's quota is hit anyway, its HTTP 429 becomes a normal "busy, try again" reply.
- **Fallback model:** `gemini-3.1-flash-lite` has the same verified free-tier quota. To
  switch, change `GEMINI_MODEL`. There is no automatic fallback.
- On the free tier, Google may use prompts to improve its products. Use fictional data.

## Known limitations

- Dates are evaluated in UTC. Shortly after midnight in a timezone ahead of UTC,
  "today" can still be yesterday in UTC, so an expense dated today may be reported as
  being in the future.
- The free tier of Gemini regularly answers HTTP 503 ("model is experiencing high demand")
  or hangs for several seconds. Retries hide most of it, but a reply can take 15-20
  seconds, or fail with "took too long", during a spike.
- Receipt reading depends on the model. A `# Expenso

**Snap. Chat. Submit.** An AI-powered business expense assistant: photograph a receipt or
describe an expense, correct it in conversation, and submit it with an explicit confirmation.
It will be reachable from a web chat and from Telegram.
Home assignment for a Full Stack Engineer position. All expense data and company
policies are fictional.

> **Status:** work in progress. The deterministic backend services, the AI assistant
> (Gemini with tool calling) and receipt photo analysis are in place and can be used from a
> terminal. Still to come: the web experience (Phase 4), Telegram with photos (Phase 5),
> cross-channel continuity (Phase 6), deployment and demo (Phase 7).

## Stack

| Part | Technology |
|---|---|
| Backend | TypeScript, Hono, Cloudflare Workers |
| Database | Cloudflare D1 (SQLite) |
| Language model | Google Gemini (`gemini-3.5-flash-lite`, free tier): tool calling and image input |
| Frontend | React, TypeScript, Vite, Tailwind CSS |
| Tests | Vitest, running inside the local Workers runtime |

Everything runs locally and on free tiers. No paid billing is needed.

## Local setup

Requires Node.js 22.12 or newer and npm.

```bash
npm install
npm run db:migrate:local      # creates the local D1 database
```

Type checking, tests and the build need no secrets. To talk to the real model, copy the
template and fill in `GEMINI_API_KEY` (a free key from Google AI Studio, no billing):

```bash
cp .env.example worker/.dev.vars
```

`worker/.dev.vars` is git-ignored. Never commit real values.

## Talking to the assistant locally

```bash
npm run chat                      # interactive; Ctrl+D to quit
npm run chat -- --user dana       # a named user; each name has its own history and expenses
npm run chat -- --new             # a brand-new user
```

This calls the shared assistant directly, with the real Gemini model and the local
database. Try:

```
I spent $42 on lunch at Cafe Nero yesterday
Actually make it $45
confirm
How much have I spent this month?
```

To try receipt analysis, send one of the fictional sample images from inside the chat
(paths are relative to the `worker` folder; any JPEG or PNG of your own works too):

```
/receipt samples/receipt-cafe-aurora.png
The total was actually $52 with the tip
confirm
/receipt samples/receipt-euro.png
/receipt samples/receipt-blurry.png
/receipt samples/not-a-receipt.png
```

Each line of output ends with the time taken and, if relevant, the error code, the receipt
result and the pending draft. Every model request counts against the limits below.

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
  src/assistant/     the channel-independent assistant: chat, receipt analysis, tools, prompt
  src/llm/           LlmClient interface and the Gemini implementation
  src/services/      deterministic business logic: policy, expenses, users, conversations, limits
  scripts/chat.ts    terminal chat for local testing
  samples/           fictional receipt images for testing
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
- Policy is checked when a draft is created and again when it is confirmed, so a draft
  that became too old while waiting cannot be submitted.
- Every query is scoped to one user. Web and Telegram users are never linked.
- Daily usage limits, per user and for the whole application, protect the free Gemini quota.

## How the assistant works

The model decides what the user means; code decides what is allowed and what happens.

- **Tools.** The model can call `get_policy`, `prepare_expense`, `cancel_draft`,
  `list_expenses` and `get_spending_summary`. Every argument is validated, and the user
  id is supplied by the backend, never by the model.
- **No submit tool.** The model can only save a draft. An expense is submitted when the
  user types `confirm` (or presses a Confirm button, once the UIs exist). That path does
  not involve the model at all. "yes" or "ok" is not a confirmation.
- **Truthful status.** Whenever a draft is saved or submitted, the status text shown to
  the user is written by code from the database. If the model's own text claims a
  submission, it is replaced.
- **Bounded work.** One user message can cause at most five model requests, each limited
  to 8 seconds, all within 22 seconds. Failed requests worth retrying (network errors,
  HTTP 5xx, hangs) are retried up to twice after a short pause. Tools only run after a
  successful response, so a retry never repeats a change.
- **Model metadata.** While a turn is in progress, the model's output is sent back to it
  exactly as received. Gemini 3 and later reject a request if a function call returns
  without the thought signature it was issued with.

### Receipt photos

`handleReceipt` takes the image bytes and an optional caption; it is the same call for
every channel.

1. The file's own first bytes must identify it as JPEG or PNG, and it must be at most 4 MB.
   Anything else is refused before the model is called or quota is used.
2. One model request transcribes the receipt into a fixed JSON shape: merchant, total,
   currency, date, suggested category, short description, and whether the image is a
   receipt at all. The model is told to return `null` for anything it cannot read.
3. Code validates every field on its own. A value that is absent, of the wrong type or out
   of range is treated as missing, never used.
4. If everything required is present and in USD, the normal policy check runs and the
   expense is saved as a **draft**. Otherwise the reply says exactly which fields are
   missing, or that the currency is unsupported, or why policy blocks it.
5. What was read is written into the conversation, so the next message ("it was
   yesterday", "the total was actually $52") continues from it.

Safeguards:

- The image is untrusted. The extraction request has no tools and no conversation
  history, so text printed on a receipt cannot trigger an action or see other data;
  extracted text is flattened to one bounded line before it is shown or reused.
- A receipt is never submitted automatically. It becomes a draft that the user confirms.
- The image is not stored. It is sent to the model and dropped; the conversation keeps
  only the placeholder `[Receipt photo]`. Nothing about the image is logged.
- Receipt analysis goes through the same quota, timeout and retry handling as chat.

### Model and quota

| Setting | Value | Where |
|---|---|---|
| `GEMINI_MODEL` | `gemini-3.5-flash-lite` | `worker/wrangler.jsonc` |
| `USER_DAILY_LLM_LIMIT` | 60 model requests per user per day | `worker/wrangler.jsonc` |
| `APP_DAILY_LLM_LIMIT` | 400 model requests per day in total | `worker/wrangler.jsonc` |
| `APP_PER_MINUTE_LLM_LIMIT` | 12 model requests in any 60 seconds, in total | `worker/wrangler.jsonc` |

- The model is stable, free of charge on Gemini's free tier, and supports function calling,
  image input and structured JSON output.
- Its free-tier quota, checked in Google AI Studio for this project (November 2026), is
  15 requests per minute, 250,000 tokens per minute and 500 requests per day. The limits
  above sit below that, leaving room for requests made outside the app.
- Every model request counts: first attempts, tool-calling rounds, retries and receipt
  extractions. A chat message that uses a tool takes two or more.
- Daily counters reset at midnight US Pacific time, the same moment Gemini's daily quota
  resets. The per-minute limit is a rolling 60-second window.
- If Google's quota is hit anyway, its HTTP 429 becomes a normal "busy, try again" reply.
- **Fallback model:** `gemini-3.1-flash-lite` has the same verified free-tier quota. To
  switch, change `GEMINI_MODEL`. There is no automatic fallback.
- On the free tier, Google may use prompts to improve its products. Use fictional data.

## Known limitations

- Dates are evaluated in UTC. Shortly after midnight in a timezone ahead of UTC,
  "today" can still be yesterday in UTC, so an expense dated today may be reported as
  being in the future.
- The free tier of Gemini regularly answers HTTP 503 ("model is experiencing high demand")
  or hangs for several seconds. Retries hide most of it, but a reply can take 15-20
  seconds, or fail with "took too long", during a spike.
 sign is read as USD even though other
  currencies use it. Only one receipt per photo is supported, and only JPEG and PNG
  (not HEIC, WebP or PDF). The format check looks at the file signature; it does not
  decode the whole image.
- Partial receipt details are carried forward as conversation text, so they are subject
  to the same 20-message history window as everything else.
- The check that replaces a false "I submitted it" from the model matches English phrases.
  The real protection is that the model has no way to submit; the check only covers wording.
- The model sees the last 20 messages as text. It does not see the results of tools from
  earlier turns and looks things up again when needed.
- `wrangler` 4 and `@cloudflare/vitest-plugin` currently ship a beta build of Miniflare
  (the local Workers simulator, `5.x-beta`). It is a development-only dependency and has
  been stable here. If it causes trouble, the fallback is to pin `wrangler` to the last
  release that bundles a stable Miniflare.

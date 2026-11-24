# Expenso

**Snap. Chat. Submit.** An AI-assisted business expense tool: photograph a receipt or
describe an expense, correct it in conversation, and submit it with an explicit confirmation.

Home assignment for a Full Stack Engineer position. All expense data and company
policies are fictional.

> **Status:** work in progress. The backend, the AI assistant, receipt analysis and the
> web app are in place and run locally. Still to come: Telegram with photos (Phase 5),
> cross-channel continuity (Phase 6), public deployment and demo video (Phase 7).

## The idea

In a chatbot, the conversation is the product. In Expenso, the **expense** is the product
and the conversation is how you work on it.

An expense is a *slip*: one object that stays on screen beside the conversation.
A receipt or a sentence creates it, talking changes that same slip, and pressing Confirm
stamps it and files it in your ledger. Policy is drawn as a ruler (your amount against
the category limit) rather than a coloured badge.

## Stack

| Part | Technology |
|---|---|
| Frontend | React, TypeScript, Vite, Tailwind CSS 4 |
| Backend | TypeScript, Hono, Cloudflare Workers |
| Database | Cloudflare D1 (SQLite) |
| Language model | Google Gemini (`gemini-3.5-flash-lite`, free tier): tool calling and image input |
| Tests | Vitest; backend tests run inside the local Workers runtime |

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

## Running the web app

Two terminals:

```bash
npm run dev:worker            # API on http://localhost:8787
npm run dev:web               # web app on http://localhost:5173 (proxies /api to the worker)
```

Open `http://localhost:5173`. A good first minute:

1. Press **Use the sample receipt**. A fictional receipt is read and becomes a draft slip.
2. Type `The total was actually $52 with the tip`. The same slip changes.
3. Press **Confirm and submit**. The slip is stamped and appears in the ledger.
4. Ask `Can I expense a $120 client dinner?`, or open the **Policy** tab and try an amount.
5. Reload the page. The conversation, the ledger and any draft are still there.

`npm run build` followed by `npm run dev:worker` serves the built app from the Worker at
`http://localhost:8787`, the way production will.

### From a terminal instead

```bash
npm run chat                      # interactive; Ctrl+D to quit
npm run chat -- --user dana       # a named user with its own history
npm run chat -- --new             # a brand-new user
```

Inside it, `/receipt samples/receipt-cafe-aurora.png` sends a receipt (paths are relative
to the `worker` folder). Other fictional samples: `receipt-euro.png`, `receipt-blurry.png`,
`not-a-receipt.png`.

## Verifying

```bash
npm run typecheck             # both workspaces
npm test                      # backend tests (local D1) and web unit tests
npm run build                 # builds the web app into web/dist
```

## Project layout

```
shared/contract.ts   API types used by both the worker and the web app
worker/
  migrations/        D1 schema
  src/index.ts       Hono app
  src/adapters/      web.ts: sessions, routes, mapping to the contract
  src/assistant/     the channel-independent assistant: chat, receipts, tools, prompt
  src/llm/           LlmClient interface and the Gemini implementation
  src/services/      deterministic business logic: policy, expenses, users, conversations, limits
  scripts/chat.ts    terminal chat
  samples/           fictional receipt images
web/
  src/components/    slip, policy (limit ruler), ledger, conversation, shell
  src/views/         Assistant (conversation + desk), Expenses, Policy
  src/state/         one reducer; the server is the source of truth
```

## Rules the backend enforces

- Money is stored as whole cents. Only USD is supported.
- Company policy is evaluated by code, never by the language model.
- An expense starts as a **draft** and is only **submitted** by an explicit confirmation
  that names that draft. Submission does not mean approval: an expense over its
  category limit is submitted and marked `needs_review`.
- A user has at most one draft, enforced by a unique index in the database.
- Confirm and cancel are atomic and safe to repeat; an outdated draft id is refused.
- Policy is checked when a draft is created and again when it is confirmed.
- Every query is scoped to one user. Web and Telegram users are never linked.
- Usage limits, per user and for the whole application, protect the free Gemini quota.

## How the assistant works

The model decides what the user means; code decides what is allowed and what happens.

- **Tools.** The model can call `get_policy`, `prepare_expense`, `cancel_draft`,
  `list_expenses` and `get_spending_summary`. Every argument is validated, and the user
  id is supplied by the backend, never by the model.
- **No submit tool.** The model can only save a draft. An expense is submitted when the
  user presses Confirm or types `confirm`. That path does not involve the model.
  "yes" or "ok" is not a confirmation.
- **Truthful status.** Whenever a draft is saved or submitted, what the user is shown is
  written by code from the database. If the model's text claims a submission, it is replaced.
- **Bounded work.** One user message can cause at most five model requests, each limited
  to 8 seconds, all within 22 seconds. Requests worth retrying (network errors, HTTP 5xx,
  hangs) are retried up to twice after a short pause. Tools only run after a successful
  response, so a retry never repeats a change.
- **Model metadata.** While a turn is in progress, the model's output is sent back to it
  exactly as received, including thought signatures.

### Receipt photos

`handleReceipt` takes the image bytes and an optional caption; it is the same call for
every channel.

1. The file's own first bytes must identify it as JPEG or PNG, and it must be at most 4 MB.
   Anything else is refused before the model is called or quota is used.
2. One model request transcribes the receipt into a fixed JSON shape. The model is told to
   return `null` for anything it cannot read.
3. Code validates every field on its own. A value that is absent, of the wrong type or out
   of range is treated as missing, never used.
4. **A currency is accepted only when the receipt names it.** A bare `$` is shared by
   several currencies, so it becomes a question to the user ("Is this in US dollars?"),
   answered with one tap and no model request.
5. If everything required is present and in USD, the normal policy check runs and the
   expense is saved as a draft. Otherwise the reply says exactly what is missing.
6. A partly read receipt is kept as structured data and given to the model on later
   messages, so "it was yesterday" completes it however long the conversation has become.

Safeguards: the extraction request has no tools and no conversation history, so text
printed on a receipt cannot trigger an action or see other data. A receipt is never
submitted automatically. The image is not stored: it is sent to the model and dropped.

### Cards

The assistant's replies carry typed *cards* (a draft event, a receipt analysis, a policy
check, a spending summary) next to plain text. The web app renders cards with its own
components; the model never produces markup. The plain text stays complete on its own,
which is what the terminal chat shows and what Telegram will show.

An expense card stores only the expense's id. Whoever displays it gets the expense as it
is now, so an old "draft created" line can truthfully say it was since replaced or submitted.

### Model and quota

| Setting | Value | Where |
|---|---|---|
| `GEMINI_MODEL` | `gemini-3.5-flash-lite` | `worker/wrangler.jsonc` |
| `USER_DAILY_LLM_LIMIT` | 60 model requests per user per day | `worker/wrangler.jsonc` |
| `APP_DAILY_LLM_LIMIT` | 400 model requests per day in total | `worker/wrangler.jsonc` |
| `APP_PER_MINUTE_LLM_LIMIT` | 12 model requests in any 60 seconds, in total | `worker/wrangler.jsonc` |

- The model's free-tier quota, checked in Google AI Studio for this project (November
  2026), is 15 requests per minute, 250,000 tokens per minute and 500 requests per day.
  The limits above sit below that.
- Every model request counts: first attempts, tool-calling rounds, retries and receipt
  extractions.
- Daily counters reset at midnight US Pacific time, when Gemini's own daily quota resets.
  The per-minute limit is a rolling 60-second window.
- **Fallback model:** `gemini-3.1-flash-lite` has the same verified quota. To switch,
  change `GEMINI_MODEL`. There is no automatic fallback.
- On the free tier, Google may use prompts to improve its products. Use fictional data.

## The web app

### Web API

All routes are under `/api` and scoped to the session. Types are in `shared/contract.ts`.

| Method & path | Purpose | Uses the model |
|---|---|---|
| `POST /session` | Open the workspace; creates a session if there is none | No |
| `POST /chat` | A text message | Yes |
| `POST /receipts` | A receipt photo (multipart `image`, optional `caption`) | Yes |
| `POST /receipts/pending/currency` | Answer the currency question | No |
| `POST /expenses/:id/confirm`, `/cancel` | Submit or discard that draft | No |
| `GET /expenses` | The user's expenses, with filters | No |
| `GET /policy`, `GET /policy/check` | Limits and rules; a verdict for an amount | No |

Every turn answers with the messages it added **and** the fresh desk state (current slip,
pending receipt, this month's figures, recent expenses), so the conversation, the slip and
the ledger cannot disagree. All figures come from the database; the browser totals nothing.

### Sessions and security

- The session is a random 256-bit token in an `HttpOnly`, `SameSite=Lax` cookie (`Secure`
  over HTTPS). Scripts cannot read it. The database stores only its SHA-256 hash.
- State-changing requests that name an origin must name ours.
- Uploads are size-checked before and after parsing, and the file's bytes decide its
  format, whatever type the browser claims.
- The static app is served with a Content-Security-Policy; the built bundle contains no
  secrets. API keys exist only in the Worker.
- There is no login. A session is anonymous and lives in one browser; clearing cookies
  starts a new one. This is a demo, and the interface says so.

### Design

- **One pinned slip** instead of a card per message. A correction changes the slip in
  place and adds one line to the conversation ("Amount changed $48.50 → $52.00").
- **Draft, submitted and policy are three separate signals.** A draft has a dashed,
  perforated edge and the words "not submitted". A submitted slip has a clean edge and a
  stamp. Policy is the limit ruler plus a sentence, and never relies on colour alone.
- **The desk**, not a dashboard: the slip in progress, and the ledger of what was filed.
  A new user sees an empty slip to drop a receipt on, not a wall of zeros.
- **Honest progress.** One true statement per request ("Reading your receipt…") with the
  real elapsed time; if the AI service is slow, it says that.
- **Receipt photos are prepared in the browser** (scaled to 1600px, re-encoded as JPEG),
  because phone photos are often larger than the server's 4 MB limit. The server still
  validates whatever arrives.
- Keyboard: Enter sends, Shift+Enter adds a line, every control is reachable with Tab,
  and focus is always visible. Motion is switched off under "reduce motion".

The Telegram entry in the top bar only explains what is coming. Nothing is connected yet.

## Known limitations

- Dates are evaluated in UTC. Shortly after midnight in a timezone ahead of UTC,
  an expense dated "today" can be reported as being in the future.
- The free tier of Gemini regularly answers HTTP 503 ("model is experiencing high demand")
  or hangs for several seconds. Retries hide most of it, but a reply can take 15–20
  seconds, or fail with "took too long", during a spike.
- Receipt reading depends on the model. One receipt per photo. The format check looks at
  the file signature; it does not decode the whole image.
- Receipt photos are shown only during the visit in which they were sent. After a reload
  the slip says the photo was not kept, because it was not.
- The check that replaces a false "I submitted it" from the model matches English phrases.
  The real protection is that the model has no way to submit.
- The check that refuses placeholder merchants ("Unknown", "Restaurant") is a short list.
  It is a backstop to the prompt, not a guarantee.
- The model sees the last 20 messages as text, plus the current draft and any pending
  receipt as structured data.
- Anyone can open many anonymous sessions, which sidesteps the per-user limit. The
  application-wide daily and per-minute limits still hold.
- `wrangler` 4 and `@cloudflare/vitest-plugin` currently ship a beta build of Miniflare
  (the local Workers simulator). It is a development-only dependency and has been stable
  here. If it causes trouble, the fallback is to pin `wrangler` to the last release that
  bundles a stable Miniflare.

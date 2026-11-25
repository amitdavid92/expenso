# Expenso

**Snap. Chat. Submit.** An AI-assisted business expense tool: photograph a receipt or
describe an expense, correct it in conversation, and submit it with an explicit confirmation.

Home assignment for a Full Stack Engineer position. All expense data and company
policies are fictional.

> **Status:** work in progress. The backend, the AI assistant, receipt analysis, the web
> app, the Telegram bot and the hand-off between them are in place and run locally (the bot
> through a Cloudflare tunnel). Still to come: public deployment and demo video (Phase 7).

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
6. **New conversation** in the top bar clears the messages and brings back the first
   screen. Submitted expenses and any draft stay.

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
  src/adapters/      web.ts (sessions, routes) and telegram.ts (webhook, buttons, photos);
                     present.ts maps stored messages to the cards both of them render
  src/assistant/     the channel-independent assistant: chat, receipts, tools, prompt
  src/llm/           LlmClient interface and the Gemini implementation
  src/services/      deterministic business logic: policy, expenses, users, conversations, limits
  scripts/           chat.ts (terminal chat), telegram-webhook.ts (register the bot's webhook)
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
  to 8 seconds (18 seconds for reading a receipt photo, which is one slower request), all
  within 22 seconds. Requests worth retrying (network errors, HTTP 5xx,
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
| `POST /conversation/reset` | New conversation: clears the messages, keeps expenses and any draft | No |
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

Screenshots from before and after the visual refinement pass are in `docs/screenshots/`.

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

## Telegram

The bot ([@GetExpensoBot](https://t.me/GetExpensoBot)) is a second adapter over the same
assistant: `worker/src/adapters/telegram.ts` calls the same `handleMessage`,
`handleReceipt`, `confirmDraftById` and `cancelDraftById` as the web routes, and
renders the same typed cards as short Telegram messages.

What it does:

- Text messages with context, receipt photos (and JPEG/PNG images sent as files) with an
  optional caption, `/start`, `/help`, `/confirm`, `/cancel`.
- A draft arrives as a preview with the policy margin in exact dollars ("$33.00 under the
  $75.00 Meals limit") and two inline buttons, **Confirm and submit** and **Discard**.
- The buttons carry that draft's id. A button from before a correction is refused, a
  second press submits nothing twice, and the services check the draft belongs to whoever
  pressed. Typing `confirm` or `cancel` works too.
- "typing…" is shown while the model works. Unsupported files, oversized files, rate
  limits, provider failures and timeouts each get a short plain answer.

How it is protected:

- Every request must carry the webhook secret in `X-Telegram-Bot-Api-Secret-Token`; with
  no secret configured the route refuses everything.
- Private chats only. Messages and button presses in groups are ignored.
- Each `update_id` is processed once, so Telegram's redeliveries do nothing.
- The route answers 200 at once and works in the background. The whole update gets 26
  seconds, inside Cloudflare's 30-second window, leaving time to say it took too long.
- Telegram puts the bot token in every URL, including file downloads. No URL is ever
  logged or put in an error; logs carry a method name, a kind and a status only.
- A Telegram user and a web session are separate users. Linking them is Phase 6.

### Connecting the bot

Telegram delivers only to a public HTTPS address, so this needs a deployed Worker (Phase 7)
or a tunnel to your machine.

```bash
npm run telegram -- info       # which bot the token belongs to, and its current webhook
npm run telegram -- secret     # prints a new random secret; add it to worker/.dev.vars
npm run telegram -- set https://<public-address>
npm run telegram -- delete     # stop deliveries
```

The token and secret are read from `worker/.dev.vars` and never printed. The Worker that
receives the webhook must have the same `TELEGRAM_WEBHOOK_SECRET` (`wrangler secret put`
in production).

To try it against your local Worker without deploying, a free quick tunnel works:

```bash
npm run telegram -- secret                      # once; paste the line into worker/.dev.vars
npm run build && npm run dev:worker             # restart so the secret is loaded
cloudflared tunnel --url http://localhost:8787  # prints an https://….trycloudflare.com address
npm run telegram -- set https://….trycloudflare.com
```

Then message the bot: `/start`, a receipt photo, a correction, **Confirm and submit**.
Run `npm run telegram -- delete` when done; the tunnel address stops working when
`cloudflared` exits.

## One conversation, two channels

Start with a receipt photo in Telegram, press **Continue on web**, and the browser opens the
same conversation, the same slip and the same ledger. Correct or submit it there; Telegram
gets a short note, and the bot knows what happened.

### How it works

**The Telegram user is the account. A browser session is a key to it.** Nothing is merged
or copied: the conversation, the draft, a half-read receipt and the expense history were
already stored against one user row, and a connected browser simply opens that row. So every
guarantee carries over unchanged: one draft per user, atomic and repeat-safe confirmation,
stale-draft refusal, the policy re-check, and the per-user quota.

- `web_sessions` maps a SHA-256 hash of each browser's cookie to an account. Several
  browsers (a phone, a laptop) can open the same account.
- `handoff_tokens` are one-time tickets that **only the bot issues**, for the Telegram user
  who wrote to it. Each ticket is a 256-bit link token and an 8-character code.

### The flow

| Step | What happens |
|---|---|
| Telegram | A draft preview carries **Continue on web ↗**; `/web` sends a link and a code at any time |
| Link | `https://<PUBLIC_WEB_URL>/#link=<token>`: the token is in the fragment, which browsers never send to a server, so it never appears in server or proxy logs. The app removes it from the address bar at once |
| Confirm | The web shows *Continue as Dana?* and what will happen to any guest data in this browser. Nothing changes until the user presses Continue |
| Redeem | One transaction marks the ticket used and creates a brand-new session. If anything fails, neither happens and the ticket still works |
| Web | The same conversation, with Telegram messages marked "via Telegram"; receipt photos show as *stayed in Telegram* (images are never stored) |
| Back | A confirm or discard on the web sends one Telegram note. The web re-reads the workspace when the tab regains focus, and every 20 seconds while connected |

**Desktop without Telegram:** open the web app, choose **Telegram**, and type the code from
`/web`. The code always travels from Telegram (where the user is already authenticated) to
the user's own screen. A QR code scanned by the phone was rejected: an attacker could show
a victim their own QR and take over the victim's account ("QRLjacking").

### Security decisions

- Tickets expire after 10 minutes and work once; two simultaneous redemptions cannot both win.
- Link tokens are stored as SHA-256. Codes are short, so they are stored as **HMAC-SHA256
  under a server key** (`LINK_CODE_KEY`, or the webhook secret), not a plain hash.
- Wrong codes are limited to 10 per browser and 200 per day across the whole app, so
  opening new guest sessions does not allow unlimited guessing.
- Links are built only from the configured `PUBLIC_WEB_URL` (https, or http on localhost),
  never from request headers. Without it, the bot offers the code only.
- A browser connected to one Telegram account refuses a link for another: it must be
  disconnected first. Identities are never switched or merged silently.
- **Handoff links are bearer credentials**: anyone holding one before it is used, within 10
  minutes, can open the account. The bot says so, sends them with link previews off, and
  the confirmation card names the account. Don't forward them.
- `/signout` in Telegram deletes every web session of the account and every unused ticket.
- Tokens, codes, cookies and token-bearing URLs are never logged.
- The Telegram note after a web confirmation is sent only when the expense actually changed
  state, after it is stored. A failed note cannot affect the expense; a repeated press sends
  nothing.

### Guest workspaces

A browser that was already used as a guest keeps that workspace. Before connecting it is
shown what is there ("2 submitted expenses and a draft") and that it will **not** be added
to the Telegram account. Its key is kept in a second HttpOnly cookie, and **Disconnect this
browser** brings it back. Moving guest data into an account is deliberately not offered.

### Using both channels at once

Both channels write the same rows, so the database decides: the last correction wins and
there is only ever one draft; confirming the same draft from both sides submits it once,
and the other side is told it was already submitted; an old button for a replaced draft is
refused. Two messages sent at the same moment from different channels are both answered,
but each turn sees the history as it was when it started, so one reply may not know about
the other message. A per-account lock was not worth its complexity here.

### Trying it

With the tunnel from the Telegram section running, add its address to `worker/.dev.vars`
as `PUBLIC_WEB_URL=https://….trycloudflare.com`, restart `npm run dev:worker`, then send a
receipt to the bot and press **Continue on web**. On a computer, open the tunnel address,
choose **Telegram** in the top bar, and enter the code from `/web`.

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
- The Telegram bot answers with separate messages, not edits of earlier ones, so an old
  draft preview stays in the chat (without buttons once pressed) above the newer one.
- The web does not get live pushes from Telegram; it refreshes on focus and every 20 seconds
  while connected.
- Each Telegram draft preview issues a fresh handoff ticket. Unused ones expire after 10
  minutes and are cleaned up as new ones are issued.
- A Telegram photo is read at the largest size Telegram offers under 4 MB. Images sent
  as files in other formats (HEIC, PDF) are refused with an explanation.
- Anyone can open many anonymous sessions, which sidesteps the per-user limit. The
  application-wide daily and per-minute limits still hold.
- `wrangler` 4 and `@cloudflare/vitest-plugin` currently ship a beta build of Miniflare
  (the local Workers simulator). It is a development-only dependency and has been stable
  here. If it causes trouble, the fallback is to pin `wrangler` to the last release that
  bundles a stable Miniflare.

import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { secureHeaders } from "hono/secure-headers";
import type {
  Bootstrap,
  Card,
  ChatMessageDto,
  DeskState,
  ErrorCode,
  ExpenseDto,
  PolicyCheckDto,
  PolicyDto,
  TurnResult,
} from "../../../shared/contract";
import { cancelDraftById, confirmDraftById, handleMessage } from "../assistant/assistant";
import { toMessageDtos } from "./present";
import { getPendingReceipt } from "../assistant/pending-receipts";
import { handleReceipt, resolvePendingCurrency } from "../assistant/receipts";
import type { AssistantDeps, AssistantReply, MessageMeta } from "../assistant/types";
import { utcDay } from "../lib/dates";
import { ValidationError } from "../lib/errors";
import { MAX_IMAGE_BYTES } from "../lib/images";
import { toCents } from "../lib/money";
import {
  type Message,
  clearConversation,
  latestMessageId,
  listMessagesAfter,
  listRecentMessages,
} from "../services/conversations";
import {
  type Expense,
  type ExpenseStatus,
  getActiveDraft,
  getExpensesByIds,
  getSpendingSummary,
  listExpenses,
} from "../services/expenses";
import { CATEGORIES, type Category, POLICY, evaluateExpense } from "../services/policy";
import { findOrCreateUser, findUser } from "../services/users";

/**
 * The web channel. It knows about HTTP, cookies and uploads, and nothing about
 * expense rules: every route resolves the user from the session cookie, calls
 * the shared assistant or a service with that user id, and maps the result to
 * the types in shared/contract.ts.
 */

const SESSION_COOKIE = "expenso_session";
const SESSION_DAYS = 30;
const HISTORY_ON_LOAD = 60;
const RECENT_ON_DESK = 8;
/** Multipart framing and a caption add a little to the image itself. */
const MAX_UPLOAD_BYTES = MAX_IMAGE_BYTES + 64 * 1024;

type Vars = { userId: number; deps: AssistantDeps };
type WebEnv = { Bindings: Env; Variables: Vars };

// ── Session ─────────────────────────────────────────────────────────────────

function newToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

/**
 * The database never holds the token itself, only this hash, so a leaked
 * table cannot be turned back into working sessions.
 */
async function sessionId(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `s:${hex}`;
}

async function userFromCookie(db: D1Database, token: string | undefined): Promise<number | null> {
  if (!token || token.length < 40 || token.length > 100) return null;
  const user = await findUser(db, "web", await sessionId(token));
  return user?.id ?? null;
}

// ── Desk state ──────────────────────────────────────────────────────────────

async function buildDesk(db: D1Database, userId: number, now: Date): Promise<DeskState> {
  const today = utcDay(now);
  const from = `${today.slice(0, 7)}-01`;
  const [currentSlip, pendingReceipt, summary, recent] = await Promise.all([
    getActiveDraft(db, userId),
    getPendingReceipt(db, userId),
    getSpendingSummary(db, userId, { from, to: today }),
    listExpenses(db, userId, { limit: RECENT_ON_DESK }),
  ]);
  return {
    currentSlip,
    pendingReceipt,
    month: { from, to: today, summary },
    recent,
    limits: { ...POLICY.limitsCents },
  };
}

// ── Routes ──────────────────────────────────────────────────────────────────

export function webRoutes(makeDeps: (env: Env) => AssistantDeps) {
  const web = new Hono<WebEnv>();
  const nowOf = (deps: AssistantDeps) => (deps.now ?? (() => new Date()))();

  web.use("*", secureHeaders());

  // The session cookie is SameSite=Lax, which already keeps it off cross-site
  // POSTs. This is a second check: a state-changing request that names an
  // origin must name ours.
  web.use("*", async (c, next) => {
    const origin = c.req.header("origin");
    if (c.req.method !== "GET" && c.req.method !== "HEAD" && origin) {
      let originHost = "";
      try {
        originHost = new URL(origin).host;
      } catch {
        // falls through to the mismatch below
      }
      // Our own host, as the browser addressed it. Behind the local dev proxy
      // that is the forwarded host; a page on another site cannot set either
      // header on a request it makes from a browser.
      const ours = [c.req.header("host"), c.req.header("x-forwarded-host"), new URL(c.req.url).host];
      if (!ours.includes(originHost)) {
        return c.json({ error: { code: "bad_origin", message: "Request refused." } }, 403);
      }
    }
    await next();
  });

  web.use("*", async (c, next) => {
    c.set("deps", makeDeps(c.env));
    await next();
  });

  /** Runs one turn and answers with what it added to the conversation plus the fresh desk. */
  async function turn(
    c: { get: <K extends keyof Vars>(key: K) => Vars[K]; json: (body: TurnResult) => Response },
    run: (deps: AssistantDeps, userId: number) => Promise<AssistantReply>,
  ): Promise<Response> {
    const deps = c.get("deps");
    const userId = c.get("userId");
    const before = await latestMessageId(deps.db, userId);
    const reply = await run(deps, userId);
    const added = await listMessagesAfter(deps.db, userId, before);

    const result: TurnResult = {
      messages: await toMessageDtos(deps.db, userId, added),
      desk: await buildDesk(deps.db, userId, nowOf(deps)),
    };
    // Something refused before anything was stored (an empty message, a file
    // that is not an image): the conversation is unchanged, so say it here.
    if (added.length === 0) {
      result.notice = { code: reply.error ?? "invalid_input", message: reply.reply };
    }
    return c.json(result);
  }

  // Opens the workspace: the existing session if the cookie is valid, a new one otherwise.
  web.post("/session", async (c) => {
    const deps = c.get("deps");
    let userId = await userFromCookie(deps.db, getCookie(c, SESSION_COOKIE));

    if (userId === null) {
      const token = newToken();
      userId = (await findOrCreateUser(deps.db, { channel: "web", externalId: await sessionId(token) })).id;
      setCookie(c, SESSION_COOKIE, token, {
        httpOnly: true, // not readable by scripts
        sameSite: "Lax",
        secure: new URL(c.req.url).protocol === "https:",
        path: "/",
        maxAge: SESSION_DAYS * 24 * 60 * 60,
      });
    }

    const history = await listRecentMessages(deps.db, userId, HISTORY_ON_LOAD);
    const body: Bootstrap = {
      messages: await toMessageDtos(deps.db, userId, history),
      desk: await buildDesk(deps.db, userId, nowOf(deps)),
    };
    return c.json(body);
  });

  // Every route below needs a session. They are listed, not wildcarded, so
  // that an unknown path is still an ordinary 404.
  const PROTECTED = [
    "/chat",
    "/conversation/*",
    "/receipts",
    "/receipts/*",
    "/expenses",
    "/expenses/*",
    "/policy",
    "/policy/*",
  ];
  web.on(["GET", "POST"], PROTECTED, async (c, next) => {
    const userId = await userFromCookie(c.get("deps").db, getCookie(c, SESSION_COOKIE));
    if (userId === null) {
      return c.json({ error: { code: "no_session", message: "No active session." } }, 401);
    }
    c.set("userId", userId);
    await next();
  });

  web.post("/chat", async (c) => {
    const body: unknown = await c.req.json().catch(() => null);
    const text = typeof body === "object" && body !== null ? (body as { text?: unknown }).text : undefined;
    if (typeof text !== "string") throw new ValidationError("Expected a JSON body with a text field.");
    return turn(c, (deps, userId) => handleMessage(deps, { userId, text }));
  });

  // "New conversation": forgets the talk, keeps the money. The draft, a pending
  // receipt and everything submitted stay exactly as they are.
  web.post("/conversation/reset", async (c) => {
    const deps = c.get("deps");
    const userId = c.get("userId");
    await clearConversation(deps.db, userId);
    const body: Bootstrap = { messages: [], desk: await buildDesk(deps.db, userId, nowOf(deps)) };
    return c.json(body);
  });

  web.post("/receipts", async (c) => {
    const tooLarge = () =>
      c.json(
        {
          error: {
            code: "image_too_large",
            message: `That image is too large. Please send a photo under ${MAX_IMAGE_BYTES / 1024 / 1024} MB.`,
          },
        },
        413,
      );
    // Refused on the declared size, before the body is read into memory.
    if (Number(c.req.header("content-length") ?? 0) > MAX_UPLOAD_BYTES) return tooLarge();

    const form = await c.req.parseBody().catch(() => null);
    const file = form?.image;
    if (!(file instanceof File)) throw new ValidationError("Expected an image file in the image field.");
    // A request can omit or understate its length, so the file itself is checked too.
    if (file.size > MAX_IMAGE_BYTES) return tooLarge();
    const caption = typeof form?.caption === "string" ? form.caption : undefined;

    // The declared content type is ignored; handleReceipt inspects the bytes.
    const image = new Uint8Array(await file.arrayBuffer());
    return turn(c, (deps, userId) => handleReceipt(deps, { userId, image, caption }));
  });

  web.post("/receipts/pending/currency", async (c) => {
    const body: unknown = await c.req.json().catch(() => null);
    const currency = typeof body === "object" && body !== null ? (body as { currency?: unknown }).currency : undefined;
    if (typeof currency !== "string") throw new ValidationError("Expected a JSON body with a currency field.");
    return turn(c, (deps, userId) => resolvePendingCurrency(deps, { userId, currency }));
  });

  const expenseId = (raw: string): number => {
    if (!/^[1-9]\d{0,14}$/.test(raw)) throw new ValidationError("Expense id must be a positive whole number.");
    return Number(raw);
  };

  web.post("/expenses/:id/confirm", async (c) => {
    const id = expenseId(c.req.param("id"));
    return turn(c, (deps, userId) => confirmDraftById(deps, { userId, expenseId: id }));
  });

  web.post("/expenses/:id/cancel", async (c) => {
    const id = expenseId(c.req.param("id"));
    return turn(c, (deps, userId) => cancelDraftById(deps, { userId, expenseId: id }));
  });

  web.get("/expenses", async (c) => {
    const q = c.req.query();
    const limit = q.limit === undefined ? 50 : Number(q.limit);
    // The service validates every filter and scopes the query to the user.
    const expenses: Expense[] = await listExpenses(c.get("deps").db, c.get("userId"), {
      status: q.status as ExpenseStatus | undefined,
      category: q.category as Category | undefined,
      from: q.from,
      to: q.to,
      limit,
    });
    return c.json({ expenses });
  });

  web.get("/policy", (c) => {
    const policy: PolicyDto = {
      currency: POLICY.currency,
      maxAgeDays: POLICY.maxAgeDays,
      limits: CATEGORIES.map((category) => ({ category, limitCents: POLICY.limitsCents[category] })),
      rules: [
        `Only ${POLICY.currency} expenses can be submitted.`,
        "An expense over its category limit can still be submitted, but it goes to manual review.",
        `An expense dated in the future or more than ${POLICY.maxAgeDays} days ago cannot be submitted.`,
        "Nothing is submitted until you confirm it yourself.",
      ],
    };
    return c.json(policy);
  });

  // "Would this be allowed?" answered by the same rule that checks real expenses. No model.
  web.get("/policy/check", (c) => {
    const { category, amount } = c.req.query();
    if (!CATEGORIES.includes(category as Category)) {
      throw new ValidationError(`Category must be one of: ${CATEGORIES.join(", ")}.`);
    }
    if (amount === undefined) throw new ValidationError("Amount is required.");
    const amountCents = toCents(amount);
    const today = utcDay(nowOf(c.get("deps")));
    const check: PolicyCheckDto = {
      category: category as Category,
      amountCents,
      limitCents: POLICY.limitsCents[category as Category],
      verdict: evaluateExpense({ amountCents, category: category as Category, expenseDate: today }, today),
    };
    return c.json(check);
  });

  return web;
}

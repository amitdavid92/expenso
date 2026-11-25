import { type Context, Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { secureHeaders } from "hono/secure-headers";
import type {
  AccountDto,
  Bootstrap,
  DeskState,
  LinkPreviewDto,
  PolicyCheckDto,
  PolicyDto,
  TurnResult,
} from "../../../shared/contract";
import { cancelDraftById, confirmDraftById, handleMessage } from "../assistant/assistant";
import { getPendingReceipt } from "../assistant/pending-receipts";
import { handleReceipt, resolvePendingCurrency } from "../assistant/receipts";
import type { AssistantDeps, AssistantReply } from "../assistant/types";
import { utcDay } from "../lib/dates";
import { ValidationError } from "../lib/errors";
import { MAX_IMAGE_BYTES } from "../lib/images";
import { toCents } from "../lib/money";
import { clearConversation, latestMessageId, listMessagesAfter, listRecentMessages } from "../services/conversations";
import {
  type Expense,
  type ExpenseStatus,
  getActiveDraft,
  getSpendingSummary,
  listExpenses,
} from "../services/expenses";
import {
  type HandoffLookup,
  codeAttemptsExhausted,
  findHandoff,
  normalizeCode,
  recordCodeFailure,
  redeemHandoff,
  spendHandoff,
} from "../services/handoff";
import { CATEGORIES, type Category, POLICY, evaluateExpense } from "../services/policy";
import {
  type AccountRow,
  SESSION_DAYS,
  createGuestSession,
  deleteSession,
  getAccount,
  guestContents,
  newToken,
  plausibleToken,
  sha256Hex,
  userForSession,
} from "../services/sessions";
import { type ChannelOptions, afterResponse } from "./channels";
import { toMessageDtos } from "./present";
import { webActionNotice } from "./telegram-render";

/**
 * The web channel. It knows about HTTP, cookies and uploads, and nothing about
 * expense rules: every route resolves the account from the session cookie,
 * calls the shared assistant or a service with that account, and maps the
 * result to the types in shared/contract.ts.
 *
 * A session opens one account: its own guest account, or, after a handoff
 * from Telegram, that Telegram account. The browser never names an account.
 */

const SESSION_COOKIE = "expenso_session";
/** The guest session a browser had before it connected to Telegram, kept so Disconnect can bring it back. */
const GUEST_COOKIE = "expenso_guest";
const HISTORY_ON_LOAD = 60;
const RECENT_ON_DESK = 8;
/** Multipart framing and a caption add a little to the image itself. */
const MAX_UPLOAD_BYTES = MAX_IMAGE_BYTES + 64 * 1024;

type Vars = { userId: number; deps: AssistantDeps };
type WebEnv = { Bindings: Env; Variables: Vars };

// ── Session ─────────────────────────────────────────────────────────────────

/** Session cookies: readable by no script, sent only to this site, HTTPS-only when served over HTTPS. */
function setSessionCookie(c: Context<WebEnv>, name: string, token: string) {
  setCookie(c, name, token, {
    httpOnly: true,
    sameSite: "Lax",
    secure: new URL(c.req.url).protocol === "https:",
    path: "/",
    maxAge: SESSION_DAYS * 24 * 60 * 60,
  });
}

function describeAccount(account: AccountRow, returnsToGuest: boolean): AccountDto {
  return account.channel === "telegram"
    ? { kind: "telegram", name: account.display_name, returnsToGuest }
    : { kind: "guest" };
}

const holdsAnything = (contents: { submitted: number; hasDraft: boolean; messages: number }) =>
  contents.submitted > 0 || contents.hasDraft || contents.messages > 0;

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

export function webRoutes(makeDeps: (env: Env) => AssistantDeps, channels: ChannelOptions) {
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

  /** The full workspace for an account, as the browser loads it. */
  async function bootstrap(c: Context<WebEnv>, userId: number): Promise<Bootstrap> {
    const deps = c.get("deps");
    const now = nowOf(deps);
    const [history, account, guest] = await Promise.all([
      listRecentMessages(deps.db, userId, HISTORY_ON_LOAD),
      getAccount(deps.db, userId),
      userForSession(deps.db, getCookie(c, GUEST_COOKIE), now),
    ]);
    return {
      messages: await toMessageDtos(deps.db, userId, history),
      desk: await buildDesk(deps.db, userId, now),
      account: describeAccount(account!, guest !== null && guest !== userId),
    };
  }

  /** Runs one turn and answers with what it added to the conversation plus the fresh desk. */
  async function turn(
    c: Context<WebEnv>,
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

  // Opens the workspace: the account this browser's session opens, or a new guest.
  web.post("/session", async (c) => {
    const deps = c.get("deps");
    let userId = await userForSession(deps.db, getCookie(c, SESSION_COOKIE), nowOf(deps));
    if (userId === null) {
      const guest = await createGuestSession(deps.db, nowOf(deps));
      setSessionCookie(c, SESSION_COOKIE, guest.token);
      userId = guest.userId;
    }
    return c.json(await bootstrap(c, userId));
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
    "/link/*",
    "/session/disconnect",
  ];
  web.on(["GET", "POST"], PROTECTED, async (c, next) => {
    const deps = c.get("deps");
    const userId = await userForSession(deps.db, getCookie(c, SESSION_COOKIE), nowOf(deps));
    if (userId === null) {
      return c.json({ error: { code: "no_session", message: "No active session." } }, 401);
    }
    c.set("userId", userId);
    await next();
  });

  // ── Continuing from Telegram ───────────────────────────────────────────────

  type LinkCheck =
    | { ok: true; handoffId: number; target: AccountRow; current: AccountRow }
    | { ok: false; response: Response };

  const refuse = (c: Context<WebEnv>, status: 404 | 409 | 410 | 429 | 503, code: string, message: string): LinkCheck => ({
    ok: false,
    response: c.json({ error: { code, message } }, status),
  });

  const AGAIN = "Send /web to Expenso in Telegram for a new one.";

  /**
   * Checks a link token or typed code against this browser without using it.
   * Preview and redeem both go through it, so they refuse for the same reasons.
   */
  async function checkLink(c: Context<WebEnv>): Promise<LinkCheck> {
    const deps = c.get("deps");
    const now = nowOf(deps);
    const body: unknown = await c.req.json().catch(() => null);
    const input = (typeof body === "object" && body !== null ? body : {}) as { token?: unknown; code?: unknown };
    const key = channels.linkKey(c.env);
    if (!key) return refuse(c, 503, "link_unavailable", "Connecting to Telegram is not set up on this server.");

    let lookup: HandoffLookup;
    const byCode = input.code !== undefined;
    if (input.token !== undefined) {
      if (!plausibleToken(input.token)) return refuse(c, 404, "link_invalid", `That link isn't valid. ${AGAIN}`);
      lookup = await findHandoff(deps.db, { token: input.token }, key, now);
    } else if (byCode) {
      // A code is short, so wrong ones are counted: per browser, and across the whole app.
      if (await codeAttemptsExhausted(deps.db, c.get("userId"), now)) {
        return refuse(c, 429, "too_many_attempts", "Too many wrong codes today. Use the link from Telegram instead.");
      }
      const code = normalizeCode(input.code);
      lookup = code ? await findHandoff(deps.db, { code }, key, now) : { status: "unknown" };
      if (lookup.status === "unknown") await recordCodeFailure(deps.db, c.get("userId"), now);
    } else {
      throw new ValidationError("Expected a token or a code.");
    }

    if (lookup.status === "unknown") {
      return refuse(c, 404, "link_invalid", byCode ? "That code isn't right. Check it and try again." : `That link isn't valid. ${AGAIN}`);
    }
    if (lookup.status !== "valid") {
      const what = byCode ? "code" : "link";
      return lookup.status === "used"
        ? refuse(c, 410, "link_used", `That ${what} was already used. ${AGAIN}`)
        : refuse(c, 410, "link_expired", `That ${what} has expired. ${AGAIN}`);
    }

    const [target, current] = await Promise.all([getAccount(deps.db, lookup.userId), getAccount(deps.db, c.get("userId"))]);
    if (!target || target.channel !== "telegram" || !current) {
      return refuse(c, 404, "link_invalid", `That link isn't valid. ${AGAIN}`);
    }
    // One browser, one Telegram account: switching accounts is always an explicit Disconnect first.
    if (current.channel === "telegram" && current.id !== target.id) {
      return refuse(
        c,
        409,
        "already_connected",
        "This browser is connected to a different Telegram account. Disconnect it first, then use the link again.",
      );
    }
    return { ok: true, handoffId: lookup.id, target, current };
  }

  // What the link would do, said before anything changes. Does not use the link.
  web.post("/link/preview", async (c) => {
    const check = await checkLink(c);
    if (!check.ok) return check.response;
    const { target, current } = check;
    const preview: LinkPreviewDto = {
      name: target.display_name,
      sameAccount: current.id === target.id,
      guest: current.channel === "web" ? await guestContents(c.get("deps").db, current.id) : null,
    };
    return c.json(preview);
  });

  // Uses the link and opens the Telegram account in this browser.
  web.post("/link/redeem", async (c) => {
    const check = await checkLink(c);
    if (!check.ok) return check.response;
    const deps = c.get("deps");
    const now = nowOf(deps);
    const { handoffId, target, current } = check;

    if (current.id === target.id) {
      // Already this account. The link is spent so it works nowhere else; nothing else changes.
      await spendHandoff(deps.db, handoffId, now);
      return c.json(await bootstrap(c, target.id));
    }

    // Always a brand-new session, so no session id can be planted in advance.
    // Using the link and creating the session are one transaction.
    const token = newToken();
    if (!(await redeemHandoff(deps.db, handoffId, await sha256Hex(token), now))) {
      return c.json(
        { error: { code: "link_used", message: `That link was already used. ${AGAIN}` } },
        410,
      );
    }

    // The guest workspace is never merged and never dropped: if it holds anything, its key is kept.
    const oldToken = getCookie(c, SESSION_COOKIE);
    const keepGuest = !!oldToken && holdsAnything(await guestContents(deps.db, current.id));
    if (keepGuest) setSessionCookie(c, GUEST_COOKIE, oldToken);
    setSessionCookie(c, SESSION_COOKIE, token);

    const body = await bootstrap(c, target.id);
    return c.json({ ...body, account: describeAccount(target, keepGuest) });
  });

  // Signs this browser out of the Telegram account. The account and its data are untouched.
  web.post("/session/disconnect", async (c) => {
    const deps = c.get("deps");
    const now = nowOf(deps);
    const current = await getAccount(deps.db, c.get("userId"));
    if (current?.channel !== "telegram") {
      return c.json({ error: { code: "not_connected", message: "This browser is not connected to Telegram." } }, 409);
    }
    const token = getCookie(c, SESSION_COOKIE);
    if (token) await deleteSession(deps.db, token);

    // Back to the guest workspace this browser had, if it is still there; otherwise a fresh guest.
    const guestToken = getCookie(c, GUEST_COOKIE);
    let userId = await userForSession(deps.db, guestToken, now);
    if (userId !== null && guestToken) {
      setSessionCookie(c, SESSION_COOKIE, guestToken);
    } else {
      const guest = await createGuestSession(deps.db, now);
      setSessionCookie(c, SESSION_COOKIE, guest.token);
      userId = guest.userId;
    }
    deleteCookie(c, GUEST_COOKIE, { path: "/" });

    const body = await bootstrap(c, userId);
    return c.json({ ...body, account: { kind: "guest" } satisfies AccountDto });
  });

  // ── The workspace ──────────────────────────────────────────────────────────

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
    return c.json({ ...(await bootstrap(c, userId)), messages: [] });
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

  /**
   * After a confirm or discard on the web of an account that also lives in
   * Telegram: tell Telegram, once. Only a real change sends a notice (a
   * repeated press changes nothing and sends nothing), it is sent after the
   * change is stored, and a failed notice cannot undo or fail the change.
   */
  async function noticeToTelegram(c: Context<WebEnv>, reply: AssistantReply | undefined): Promise<void> {
    if (!reply?.transition) return;
    const account = await getAccount(c.get("deps").db, c.get("userId"));
    const chatId = Number(account?.external_id);
    if (account?.channel !== "telegram" || !Number.isSafeInteger(chatId)) return;
    const api = channels.telegramApi(c.env);
    if (!api) return;
    const text = webActionNotice(reply.transition);
    await afterResponse(
      c,
      api
        .call("sendMessage", { chat_id: chatId, text, parse_mode: "HTML", link_preview_options: { is_disabled: true } })
        .catch((error: unknown) => {
          // The kind of failure only: never the message, the chat or a URL.
          console.warn(`telegram_notice_failed error=${error instanceof Error ? error.name : "unknown"}`);
        }),
    );
  }

  web.post("/expenses/:id/confirm", async (c) => {
    const id = expenseId(c.req.param("id"));
    let reply: AssistantReply | undefined;
    const response = await turn(c, async (deps, userId) => {
      reply = await confirmDraftById(deps, { userId, expenseId: id });
      return reply;
    });
    await noticeToTelegram(c, reply);
    return response;
  });

  web.post("/expenses/:id/cancel", async (c) => {
    const id = expenseId(c.req.param("id"));
    let reply: AssistantReply | undefined;
    const response = await turn(c, async (deps, userId) => {
      reply = await cancelDraftById(deps, { userId, expenseId: id });
      return reply;
    });
    await noticeToTelegram(c, reply);
    return response;
  });

  web.get("/expenses", async (c) => {
    const q = c.req.query();
    const limit = q.limit === undefined ? 50 : Number(q.limit);
    // The service validates every filter and scopes the query to the account.
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

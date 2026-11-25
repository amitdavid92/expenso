import type {
  Category,
  ChatMessageDto,
  ExpenseDto,
  FieldChange,
  ReceiptAnalysisDto,
  SpendingSummaryDto,
} from "../../../shared/contract";
import { describeReceiptFields } from "../assistant/format";
import { formatCents } from "../lib/money";
import { POLICY } from "../services/policy";

/**
 * Turns the same typed messages the web app renders as cards into Telegram
 * messages: a few short lines of HTML and, for a live draft, inline buttons.
 * Pure functions; nothing here talks to Telegram or the database.
 */

/** A button that acts in the bot (callback_data) or opens a page (url). */
export type InlineButton = { text: string; callback_data: string } | { text: string; url: string };

export interface TelegramMessage {
  /** Telegram HTML. Everything that came from a user, a receipt or the model is escaped. */
  text: string;
  buttons?: InlineButton[][];
}

/** Button payloads. Short, and they carry the draft's id so a press can only act on that draft. */
export const CALLBACK = {
  confirm: (expenseId: number) => `c:${expenseId}`,
  cancel: (expenseId: number) => `x:${expenseId}`,
  currency: (code: string) => `u:${code}`,
};

export type CallbackAction =
  | { kind: "confirm" | "cancel"; expenseId: number }
  | { kind: "currency"; currency: string };

/** Reads a button payload back. Anything that is not exactly one of ours is ignored. */
export function parseCallback(data: unknown): CallbackAction | null {
  if (typeof data !== "string") return null;
  const draft = /^([cx]):([1-9]\d{0,14})$/.exec(data);
  if (draft) return { kind: draft[1] === "c" ? "confirm" : "cancel", expenseId: Number(draft[2]) };
  const currency = /^u:([A-Z]{3})$/.exec(data);
  if (currency) return { kind: "currency", currency: currency[1]! };
  return null;
}

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;" };
export const esc = (text: string): string => text.replace(/[&<>]/g, (c) => ESCAPES[c]!);

const CATEGORY_LABEL: Record<Category, string> = {
  meals: "Meals",
  travel: "Travel",
  lodging: "Lodging",
  software: "Software",
  office: "Office",
  other: "Other",
};

const dayFormat = new Intl.DateTimeFormat("en-GB", {
  weekday: "short",
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});
const monthFormat = new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
const day = (iso: string) => dayFormat.format(new Date(`${iso.slice(0, 10)}T00:00:00Z`)).replace(",", "");

/** Policy in one line, with the exact distance from the category's limit. */
export function policyLine(category: Category, amountCents: number): string {
  const limit = POLICY.limitsCents[category];
  const limitText = `the ${formatCents(limit)} ${CATEGORY_LABEL[category]} limit`;
  if (amountCents > limit) {
    return `${formatCents(amountCents - limit)} over ${limitText} · goes to manual review`;
  }
  if (amountCents === limit) return `Exactly at ${limitText} · within policy`;
  return `${formatCents(limit - amountCents)} under ${limitText} · within policy`;
}

function expenseLines(expense: ExpenseDto): string[] {
  return [
    `<b>${formatCents(expense.amountCents)}</b> · ${esc(expense.merchant)}`,
    `${day(expense.expenseDate)} · ${CATEGORY_LABEL[expense.category]}`,
    ...(expense.description ? [`<i>${esc(expense.description)}</i>`] : []),
    policyLine(expense.category, expense.amountCents),
  ];
}

const FIELD_LABEL: Record<FieldChange["field"], string> = {
  amount: "Amount",
  category: "Category",
  merchant: "Merchant",
  date: "Date",
  description: "Note",
};

function changeLine(change: FieldChange): string {
  const label = FIELD_LABEL[change.field];
  if (change.field === "description") return change.to === "" ? "Note removed" : "Note updated";
  const show = (value: string) => (change.field === "date" ? day(value) : value);
  return `${label} changed ${esc(show(change.from))} → ${esc(show(change.to))}`;
}

/** True for a message whose buttons act on a live draft: it is worth offering to continue on the web. */
export function hasDraftButtons(message: TelegramMessage): boolean {
  return !!message.buttons?.some((row) => row.some((b) => "callback_data" in b && b.callback_data.startsWith("c:")));
}

/** The buttons under a live draft. This is the one place they are built. */
function draftButtons(expense: ExpenseDto): InlineButton[][] {
  return [
    [
      { text: "Confirm and submit", callback_data: CALLBACK.confirm(expense.id) },
      { text: "Discard", callback_data: CALLBACK.cancel(expense.id) },
    ],
  ];
}

function draftBlock(expense: ExpenseDto): string[] {
  return ["<b>Draft · not submitted</b>", ...expenseLines(expense), "Nothing is sent until you confirm."];
}

function receiptBlock(analysis: ReceiptAnalysisDto): { lines: string[]; buttons?: InlineButton[][] } {
  const read = describeReceiptFields(analysis.fields);
  const lines = read ? [`<b>Read from the receipt</b>`, esc(read)] : [];

  if (analysis.status === "needs_details") {
    const askCurrency = analysis.missing.includes("currency") && !!analysis.suggestedCurrency;
    const others = analysis.missing.filter((field) => !(field === "currency" && askCurrency));
    if (others.length > 0) lines.push(`Still needed: ${others.join(", ")}. Just tell me.`);
    if (askCurrency) {
      const code = analysis.suggestedCurrency!;
      lines.push(`The receipt shows a currency symbol but not which currency. Is the total in ${code}?`);
      return {
        lines,
        buttons: [[{ text: `Yes, ${code}`, callback_data: CALLBACK.currency(code) }]],
      };
    }
  }
  return { lines };
}

function summaryLines(summary: SpendingSummaryDto, from?: string, to?: string): string[] {
  const period =
    from && to && from.slice(0, 7) === to.slice(0, 7)
      ? monthFormat.format(new Date(`${from}T00:00:00Z`))
      : from
        ? `since ${day(from)}`
        : "all time";
  if (summary.count === 0) return [];
  return [
    `<b>Submitted · ${period}</b>`,
    `<b>${formatCents(summary.totalCents)}</b> · ${summary.count} ${summary.count === 1 ? "expense" : "expenses"}`,
    ...summary.byCategory.map((c) => `${CATEGORY_LABEL[c.category]} ${formatCents(c.totalCents)} (${c.count})`),
    ...(summary.needsReviewCount > 0 ? [`${summary.needsReviewCount} waiting for manual review`] : []),
  ];
}

/** One assistant message, as Telegram will show it. */
export function renderMessage(message: ChatMessageDto): TelegramMessage {
  const blocks: string[] = [];
  let buttons: InlineButton[][] | undefined;
  if (message.text) blocks.push(esc(message.text));

  const card = message.card;
  if (card?.kind === "expense") {
    const { expense, event } = card;
    if (event === "submitted") {
      blocks.push(
        [
          "<b>Submitted for processing</b>",
          ...expenseLines(expense),
          "Submitted means sent for processing, not yet reimbursed.",
        ].join("\n"),
      );
    } else if (event === "cancelled") {
      blocks.push(`Draft discarded · ${formatCents(expense.amountCents)} · ${esc(expense.merchant)}`);
    } else if (expense.status === "draft") {
      if (card.changes?.length) blocks.push(card.changes.map(changeLine).join("\n"));
      blocks.push(draftBlock(expense).join("\n"));
      buttons = draftButtons(expense);
    }
  } else if (card?.kind === "receipt") {
    if (card.analysis.status === "draft_created" && card.expense?.status === "draft") {
      blocks.push(draftBlock(card.expense).join("\n"));
      buttons = draftButtons(card.expense);
    } else if (card.analysis.status !== "not_a_receipt" && card.analysis.status !== "unreadable") {
      const block = receiptBlock(card.analysis);
      if (block.lines.length > 0) blocks.push(block.lines.join("\n"));
      buttons = block.buttons;
    }
  } else if (card?.kind === "policy_check") {
    blocks.push(policyLine(card.category, card.amountCents));
  } else if (card?.kind === "summary") {
    const lines = summaryLines(card.summary, card.from, card.to);
    if (lines.length > 0) blocks.push(lines.join("\n"));
  }

  // Telegram refuses messages over 4096 characters.
  return { text: blocks.join("\n\n").slice(0, 4000) || "Done.", buttons };
}

/** The row that opens this conversation in a browser. The link is a one-time key; it is never logged. */
export function continueOnWebRow(link: string): InlineButton[] {
  return [{ text: "Continue on web ↗", url: link }];
}

/** The /web answer: the link (if a public address is configured) and the code, with how to treat them. */
export function webAccessMessage(input: { link: string | null; code: string; webUrl: string | null }): TelegramMessage {
  const where = input.webUrl ? `open <b>${esc(input.webUrl.replace(/^https?:\/\//, ""))}</b>, choose Telegram, and` : "open Expenso on the web, choose Telegram, and";
  return {
    text: [
      "<b>Continue on the web</b>",
      input.link
        ? "Tap the button to open this conversation, your current slip and your ledger in a browser."
        : "Open Expenso in a browser to see this conversation, your current slip and your ledger.",
      `On a computer without Telegram, ${where} enter this code:\n<code>${input.code}</code>`,
      "The link and the code work once and expire in 10 minutes. Don't forward them: anyone who has them can open your expenses. /signout signs every browser out.",
    ].join("\n\n"),
    buttons: input.link ? [continueOnWebRow(input.link)] : undefined,
  };
}

/** A short note in Telegram about something done on the web, sent only when it actually changed an expense. */
export function webActionNotice(transition: { kind: "submitted" | "cancelled"; expense: ExpenseDto }): string {
  const { expense } = transition;
  if (transition.kind === "cancelled") {
    return `Discarded on the web · ${formatCents(expense.amountCents)} · ${esc(expense.merchant)}`;
  }
  return [
    `<b>Submitted on the web</b> · ${formatCents(expense.amountCents)} · ${esc(expense.merchant)}`,
    policyLine(expense.category, expense.amountCents),
  ].join("\n");
}

export const WELCOME = [
  "<b>Expenso</b> · Snap. Chat. Submit.",
  "Send me a photo of a receipt and I'll turn it into an expense draft for you to check. Or just tell me what you spent. Everything here is also on the web: send /web to continue there.",
  [
    "Things to try:",
    "· a photo of a receipt",
    "· I spent $42 on lunch at Cafe Nero yesterday",
    "· Can I expense a $120 client dinner?",
    "· How much have I spent this month?",
  ].join("\n"),
  "Nothing is submitted until you press Confirm. This is a demo with fictional data, so please don't send real receipts.",
].join("\n\n");

export const HELP = [
  "<b>How Expenso works</b>",
  "Send a receipt photo, or describe an expense in your own words. I prepare a draft and check it against company policy. To change it, just say what is different.",
  [
    "/confirm · submit the current draft",
    "/cancel · discard it",
    "/web · continue this conversation in a browser",
    "/signout · sign every browser out",
    "/help · this message",
  ].join("\n"),
  "The buttons under a draft do the same as /confirm and /cancel. Only USD is supported.",
].join("\n\n");

export const UNSUPPORTED = "I can read receipt photos in JPEG or PNG format, and plain text messages. Send a photo of the receipt, or type the expense.";
export const TOO_LARGE = "That file is too large. Please send a photo under 4 MB (sending it as a photo instead of a file usually works).";
export const DOWNLOAD_FAILED = "I couldn't download that photo from Telegram. Please send it again.";
export const SOMETHING_WRONG = "Something went wrong on my side. Please try again in a moment.";
export const TOOK_TOO_LONG = "That took too long, so I stopped. Please try again.";

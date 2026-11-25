import type { Card, ChatMessageDto, ReceiptAnalysisDto } from "../../../../shared/contract";
import { CATEGORY_LABEL, describeChange, money, month } from "../../lib/format";
import { ErrorState } from "../ErrorState";
import { AlertIcon, CheckIcon, DiscardIcon, EditIcon, SlipIcon } from "../Icons";
import { SpendingSummary } from "../ledger/SpendingSummary";
import { PolicyCheck } from "../policy/PolicyCheck";

/**
 * One line in the conversation recording something that happened to a slip.
 * The slip itself lives on the desk; the conversation keeps the story of it.
 */
export function EventLine({ icon, children, tone = "ink" }: { icon: React.ReactNode; children: React.ReactNode; tone?: "ink" | "indigo" | "review" }) {
  const color = tone === "indigo" ? "text-indigo" : tone === "review" ? "text-review" : "text-ink-2";
  return (
    <p className={`flex items-start gap-2 text-sm ${color}`}>
      <span className="mt-0.5 shrink-0">{icon}</span>
      <span className="text-ink-2">{children}</span>
    </p>
  );
}

const Figure = ({ children }: { children: React.ReactNode }) => <span className="figure text-ink">{children}</span>;

function receiptLine(analysis: ReceiptAnalysisDto): string | null {
  switch (analysis.status) {
    case "draft_created":
      return "Receipt read · every detail found";
    case "needs_details":
      return `Receipt read in part · still needed: ${analysis.missing.join(", ")}`;
    case "unsupported_currency":
      return `Receipt read · it is in ${analysis.fields.currency}, which is not supported`;
    case "blocked_by_policy":
      return "Receipt read · policy does not allow it";
    default:
      return null; // "not a receipt" and "unreadable" are fully said by the text.
  }
}

function CardView({ card }: { card: Card }) {
  if (card.kind === "policy_check") return <PolicyCheck check={card} />;

  if (card.kind === "summary") {
    if (card.summary.count === 0) return null;
    return (
      <div className="max-w-md rounded-lg border border-line bg-paper p-4">
        <div className="mb-3 flex items-baseline justify-between gap-3">
          <span className="text-sm text-ink-2">
            Submitted{card.from ? ` · ${card.to && card.from.slice(0, 7) === card.to.slice(0, 7) ? month(card.from) : `from ${card.from}`}` : " · all time"}
          </span>
          <span className="figure text-lg font-medium">{money(card.summary.totalCents)}</span>
        </div>
        <SpendingSummary summary={card.summary} />
      </div>
    );
  }

  if (card.kind === "receipt") {
    const line = receiptLine(card.analysis);
    if (!line) return null;
    const complete = card.analysis.status === "draft_created";
    return (
      <EventLine tone={complete ? "indigo" : "review"} icon={complete ? <SlipIcon width={16} height={16} /> : <AlertIcon width={16} height={16} />}>
        {line}
      </EventLine>
    );
  }

  // An expense event. `card.expense` is the expense as it is now, which lets an
  // old line say what became of that draft.
  const { expense, event, changes } = card;
  const later =
    event === "drafted" || event === "updated"
      ? expense.status === "cancelled"
        ? " · since replaced or discarded"
        : expense.status === "submitted"
          ? " · since submitted"
          : ""
      : "";

  if (event === "submitted") {
    return (
      <EventLine tone="indigo" icon={<CheckIcon width={16} height={16} />}>
        Submitted <Figure>{money(expense.amountCents)}</Figure> · {expense.merchant} · {CATEGORY_LABEL[expense.category]}
        {expense.policyResult === "needs_review" && <span className="text-review"> · needs manual review</span>}
      </EventLine>
    );
  }
  if (event === "cancelled") {
    return (
      <EventLine icon={<DiscardIcon width={16} height={16} />}>
        Draft discarded · <Figure>{money(expense.amountCents)}</Figure> · {expense.merchant}
      </EventLine>
    );
  }
  if (event === "updated" && changes?.length) {
    return (
      <div className="space-y-1">
        {changes.map((change) => (
          <EventLine key={change.field} tone="indigo" icon={<EditIcon width={16} height={16} />}>
            {describeChange(change)}
            {later}
          </EventLine>
        ))}
      </div>
    );
  }
  return (
    <EventLine tone="indigo" icon={<SlipIcon width={16} height={16} />}>
      Draft {event === "updated" ? "updated" : "created"} · <Figure>{money(expense.amountCents)}</Figure> · {expense.merchant}
      {later}
    </EventLine>
  );
}

function Paragraphs({ text }: { text: string }) {
  return (
    <>
      {text
        .split(/\n+/)
        .filter((line) => line.trim() !== "")
        .map((line, i) => (
          // Static text that is never reordered, so the index is a stable key.
          <p key={i}>{line}</p>
        ))}
    </>
  );
}

/**
 * A message. The user's words sit quietly on the right; the assistant's read
 * like a document on the left, followed by whatever the turn actually did.
 */
export function Message({
  message,
  photo,
  onRetry,
  busy,
}: {
  message: ChatMessageDto;
  /** The receipt photo sent with this message, if it is still in this browser tab. */
  photo?: string;
  /** Given only for the newest message, when retrying could help. */
  onRetry?: () => void;
  busy: boolean;
}) {
  if (message.role === "user") {
    return (
      <div className="flex animate-settle flex-col items-end gap-1.5">
        {message.attachment &&
          (photo ? (
            <img src={photo} alt="Receipt you sent" className="h-32 w-auto max-w-40 rounded-lg border border-line object-cover object-top" />
          ) : (
            <span className="inline-flex items-center gap-1.5 rounded-lg border border-dashed border-line-strong px-3 py-2 text-sm text-ink-2">
              <SlipIcon width={16} height={16} />
              Receipt photo · not kept
            </span>
          ))}
        {message.text && (
          <p className="max-w-[85%] rounded-2xl rounded-br-md bg-ink px-4 py-2.5 text-paper break-words whitespace-pre-wrap">
            {message.text}
          </p>
        )}
      </div>
    );
  }

  if (message.error) {
    return (
      <div className="animate-settle space-y-2.5">
        <ErrorState onRetry={message.error.retryable ? onRetry : undefined} busy={busy}>
          {message.text}
        </ErrorState>
        {message.card && <CardView card={message.card} />}
      </div>
    );
  }

  return (
    <div className="flex animate-settle gap-3">
      <span
        className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-md bg-indigo text-2xs leading-none font-bold text-white"
        aria-hidden="true"
      >
        e.
      </span>
      <div className="min-w-0 flex-1 space-y-2.5">
        <span className="sr-only">Expenso:</span>
        {message.text && (
          <div className="max-w-[62ch] space-y-2 text-ink">
            <Paragraphs text={message.text} />
          </div>
        )}
        {message.card && <CardView card={message.card} />}
      </div>
    </div>
  );
}

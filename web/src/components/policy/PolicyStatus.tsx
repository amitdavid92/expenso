import type { PolicyVerdictDto } from "../../../../shared/contract";
import { AlertIcon, CheckIcon, StopIcon } from "../Icons";

/**
 * The policy verdict in words, with an icon. It is separate from whether an
 * expense has been submitted: a slip can be submitted and still need review.
 */
export function PolicyStatus({ verdict }: { verdict: PolicyVerdictDto }) {
  if (verdict.outcome === "within_policy") {
    return (
      <p className="flex items-center gap-1.5 text-sm text-ok">
        <CheckIcon width={16} height={16} />
        Within policy
      </p>
    );
  }

  const blocked = verdict.outcome === "blocked";
  // For "over the limit" the ruler beside this line already shows the figures.
  const details = blocked ? verdict.reasons : [];
  return (
    <div className={`flex gap-1.5 text-sm ${blocked ? "text-stop" : "text-review"}`}>
      {blocked ? (
        <StopIcon width={16} height={16} className="mt-0.5 shrink-0" />
      ) : (
        <AlertIcon width={16} height={16} className="mt-0.5 shrink-0" />
      )}
      <p>
        <span className="font-medium">
          {blocked ? "Can't be submitted" : "Over the limit · goes to manual review"}
        </span>
        {details.length > 0 && <span className="text-ink-2"> · {details.join(" ")}</span>}
      </p>
    </div>
  );
}

/** The verdict stored on an expense, in the shape PolicyStatus takes. */
export function verdictOf(expense: { policyResult: "within_policy" | "needs_review"; policyNotes: string | null }): PolicyVerdictDto {
  return expense.policyResult === "within_policy"
    ? { outcome: "within_policy" }
    : { outcome: "needs_review", notes: expense.policyNotes ? [expense.policyNotes] : [] };
}

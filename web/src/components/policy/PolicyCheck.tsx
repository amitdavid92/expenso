import type { PolicyCheckDto } from "../../../../shared/contract";
import { LimitRuler } from "./LimitRuler";
import { PolicyStatus } from "./PolicyStatus";

/** "Would this be allowed?": the ruler and the verdict together. Used in the conversation and on the policy page. */
export function PolicyCheck({ check }: { check: PolicyCheckDto }) {
  return (
    <div className="max-w-md space-y-3 rounded-lg border border-line bg-paper p-4">
      <LimitRuler category={check.category} amountCents={check.amountCents} limitCents={check.limitCents} />
      <PolicyStatus verdict={check.verdict} />
    </div>
  );
}

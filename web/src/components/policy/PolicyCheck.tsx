import type { PolicyCheckDto } from "../../../../shared/contract";
import { LimitRuler } from "./LimitRuler";
import { PolicyStatus } from "./PolicyStatus";

/** "Would this be allowed?": the ruler and the verdict together. Used in the conversation and on the policy page. */
export function PolicyCheck({ check, bare = false }: { check: PolicyCheckDto; /** Inside a panel that already has an edge. */ bare?: boolean }) {
  return (
    <div className={bare ? "max-w-md space-y-3" : "max-w-md space-y-3 rounded-xl border border-line bg-paper p-4 shadow-(--shadow-lift)"}>
      <LimitRuler category={check.category} amountCents={check.amountCents} limitCents={check.limitCents} />
      <PolicyStatus verdict={check.verdict} />
    </div>
  );
}

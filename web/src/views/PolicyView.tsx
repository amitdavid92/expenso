import { useEffect, useState } from "react";
import { CATEGORIES, type Category, type PolicyCheckDto, type PolicyDto } from "../../../shared/contract";
import * as api from "../api/client";
import { ErrorState } from "../components/ErrorState";
import { PolicyCheck } from "../components/policy/PolicyCheck";
import { Select } from "../components/Select";
import { CATEGORY_LABEL, money } from "../lib/format";

const AMOUNT = /^\d+(\.\d{1,2})?$/;

/**
 * "Before you spend": pick a category, type an amount, and see the verdict the
 * backend would give a real expense. It is the same rule, run by the same code;
 * no AI is involved, so it answers at once and costs nothing.
 */
function TryIt() {
  const [category, setCategory] = useState<Category>("meals");
  const [amount, setAmount] = useState("120");
  const [check, setCheck] = useState<PolicyCheckDto | null>(null);
  const [failed, setFailed] = useState(false);
  const valid = AMOUNT.test(amount) && Number(amount) > 0;

  useEffect(() => {
    if (!valid) return;
    let current = true;
    // A short pause so a request is not sent for every keystroke.
    const timer = setTimeout(() => {
      api
        .checkPolicy(category, amount)
        .then((result) => {
          if (!current) return;
          setCheck(result);
          setFailed(false);
        })
        .catch(() => current && setFailed(true));
    }, 180);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [category, amount, valid]);

  return (
    <section aria-labelledby="try-title" className="mt-8">
      <h2 id="try-title" className="text-lg font-medium">
        Before you spend
      </h2>
      <p className="mt-1 max-w-[60ch] text-ink-2">
        Try an amount. The answer comes from the same rule that checks a real expense, with no AI involved.
      </p>

      <div className="mt-4 flex flex-wrap items-end gap-3">
        <label className="text-sm text-ink-2">
          <span className="mb-1 block">Category</span>
          <Select value={category} onChange={(event) => setCategory(event.target.value as Category)}>
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {CATEGORY_LABEL[c]}
              </option>
            ))}
          </Select>
        </label>
        <label className="text-sm text-ink-2">
          <span className="mb-1 block">Amount in USD</span>
          <span className="flex min-h-11 items-center rounded-lg border border-line-strong bg-paper pl-3 focus-within:border-indigo">
            <span className="figure text-ink-3">$</span>
            <input
              inputMode="decimal"
              value={amount}
              onChange={(event) => setAmount(event.target.value.trim())}
              aria-invalid={!valid}
              aria-describedby={valid ? undefined : "amount-help"}
              className="figure w-28 bg-transparent px-1.5 py-2 text-base text-ink outline-none"
            />
          </span>
        </label>
      </div>

      <div className="mt-4 min-h-[6.5rem]">
        {!valid ? (
          <p id="amount-help" className="text-sm text-stop">
            Enter an amount in dollars, such as 48.50.
          </p>
        ) : failed ? (
          <ErrorState>The check could not be run. Try again in a moment.</ErrorState>
        ) : check ? (
          <PolicyCheck check={check} />
        ) : (
          <div className="skeleton h-24 max-w-md" />
        )}
      </div>
    </section>
  );
}

/** The company policy as the backend holds it: limits, rules, and a way to try an amount. */
export function PolicyView() {
  const [policy, setPolicy] = useState<PolicyDto | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let current = true;
    api
      .getPolicy()
      .then((result) => current && setPolicy(result))
      .catch(() => current && setFailed(true));
    return () => {
      current = false;
    };
  }, [attempt]);

  return (
    <main className="mx-auto w-full max-w-4xl flex-1 px-4 py-8 sm:px-8">
      <h1 className="text-2xl font-medium tracking-tight">Company policy</h1>
      <p className="mt-1 max-w-[60ch] text-ink-2">
        A fictional policy for this demo. It is applied by code on the server, never by the AI assistant.
      </p>

      <TryIt />

      <section aria-labelledby="limits-title" className="mt-10">
        <h2 id="limits-title" className="text-lg font-medium">
          Limits per expense
        </h2>

        {failed && !policy && (
          <div className="mt-3">
            <ErrorState onRetry={() => { setFailed(false); setAttempt((n) => n + 1); }}>The policy could not be loaded.</ErrorState>
          </div>
        )}

        {!policy && !failed && <div className="skeleton mt-3 h-56 max-w-md" />}

        {policy && (
          <>
            <table className="mt-3 w-full max-w-md text-left text-sm">
              <thead>
                <tr className="border-b border-line text-ink-2">
                  <th scope="col" className="py-2 font-medium">Category</th>
                  <th scope="col" className="py-2 text-right font-medium">Limit ({policy.currency})</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {policy.limits.map((limit) => (
                  <tr key={limit.category}>
                    <td className="py-2.5 text-ink">{CATEGORY_LABEL[limit.category]}</td>
                    <td className="figure py-2.5 text-right text-ink">{money(limit.limitCents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            <h2 className="mt-10 text-lg font-medium">Rules</h2>
            <ul className="mt-3 max-w-[65ch] space-y-2 text-ink-2">
              {policy.rules.map((rule) => (
                <li key={rule} className="flex gap-2.5">
                  <span className="mt-[0.6em] size-1 shrink-0 rounded-full bg-ink-3" aria-hidden="true" />
                  {rule}
                </li>
              ))}
            </ul>
          </>
        )}
      </section>
    </main>
  );
}

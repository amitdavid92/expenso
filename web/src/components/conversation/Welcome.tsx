import { useRef } from "react";
import { firstImage } from "../slip/DropZone";

function Example({ children, onClick, disabled }: { children: string; onClick: () => void; disabled: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="min-h-11 rounded-lg border border-line bg-paper px-3 py-2 text-left text-sm text-ink transition-colors hover:border-indigo hover:text-indigo disabled:opacity-55"
    >
      {children}
    </button>
  );
}

/**
 * The first screen. It says what the product does in its own three words and
 * offers four ways in, each with something to press that really works, so a
 * first-time visitor never has to guess what to type.
 */
export function Welcome({
  onPrompt,
  onFile,
  onSample,
  disabled,
}: {
  onPrompt: (text: string) => void;
  onFile: (file: File) => void;
  onSample: () => void;
  disabled: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);

  const starts: { title: string; about: string; actions: React.ReactNode }[] = [
    {
      title: "Scan a receipt",
      about: "A photo becomes a draft you can check against the original.",
      // Beside the slip (wide screens) the slip itself carries these two actions.
      actions: (
        <>
          <span className="contents desk:hidden">
            <Example onClick={() => input.current?.click()} disabled={disabled}>
              Choose a photo
            </Example>
            <Example onClick={onSample} disabled={disabled}>
              Use the sample receipt
            </Example>
          </span>
          <p className="hidden self-center text-sm text-ink-2 desk:block">
            Drop a photo on the blank slip to the right, or use the sample receipt there.
          </p>
        </>
      ),
    },
    {
      title: "Before you spend",
      about: "Check the company policy before the money is gone.",
      actions: (
        <>
          <Example onClick={() => onPrompt("Can I expense a $120 client dinner?")} disabled={disabled}>
            Can I expense a $120 client dinner?
          </Example>
          <Example onClick={() => onPrompt("What are the limits for travel and lodging?")} disabled={disabled}>
            What are the limits for travel and lodging?
          </Example>
        </>
      ),
    },
    {
      title: "Report an expense",
      about: "Say what you spent in your own words. Correct it the same way.",
      actions: (
        <>
          <Example onClick={() => onPrompt("I spent $42 on lunch at Cafe Nero yesterday")} disabled={disabled}>
            I spent $42 on lunch at Cafe Nero yesterday
          </Example>
          <Example onClick={() => onPrompt("Taxi to the airport this morning, $63.40, Metro Cabs")} disabled={disabled}>
            Taxi to the airport this morning, $63.40, Metro Cabs
          </Example>
        </>
      ),
    },
    {
      title: "Spending insights",
      about: "Ask about what you have already submitted.",
      actions: (
        <>
          <Example onClick={() => onPrompt("How much have I spent this month?")} disabled={disabled}>
            How much have I spent this month?
          </Example>
          <Example onClick={() => onPrompt("Show my submitted meals expenses")} disabled={disabled}>
            Show my submitted meals expenses
          </Example>
        </>
      ),
    },
  ];

  return (
    <div className="mx-auto w-full max-w-2xl pt-6 pb-4 desk:pt-12">
      <h1 className="text-[2rem] leading-tight font-medium tracking-tight sm:text-[2.5rem]">
        Snap. Chat. <span className="text-indigo">Submit.</span>
      </h1>
      <p className="mt-3 max-w-[52ch] text-ink-2">
        Expenses made effortless. Turn a receipt or a sentence into a draft, fix it by talking, and submit it only when
        you say so.
      </p>

      <dl className="mt-8 divide-y divide-line border-y border-line">
        {starts.map((start) => (
          <div key={start.title} className="grid gap-x-6 gap-y-2.5 py-4 sm:grid-cols-[11rem_1fr]">
            <dt>
              <span className="block font-medium text-ink">{start.title}</span>
              <span className="mt-0.5 block text-sm text-ink-2">{start.about}</span>
            </dt>
            <dd className="flex flex-wrap content-start gap-2">{start.actions}</dd>
          </div>
        ))}
      </dl>

      <input
        ref={input}
        type="file"
        accept="image/*"
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        onChange={(event) => {
          const file = firstImage(event.target.files);
          if (file) onFile(file);
          event.target.value = "";
        }}
      />
    </div>
  );
}

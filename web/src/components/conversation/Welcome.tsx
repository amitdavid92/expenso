import { useRef } from "react";
import { ArrowIcon, BarsIcon, CameraIcon, ShieldIcon, SlipIcon } from "../Icons";
import { firstImage } from "../slip/DropZone";

/** A way in that is not a receipt: a title, what it is for, and a real question that sends on click. */
function Start({
  icon,
  title,
  about,
  prompt,
  onPrompt,
  disabled,
}: {
  icon: React.ReactNode;
  title: string;
  about: string;
  prompt: string;
  onPrompt: (text: string) => void;
  disabled: boolean;
}) {
  return (
    <button
      type="button"
      onClick={() => onPrompt(prompt)}
      disabled={disabled}
      className="group flex min-h-11 flex-col rounded-xl border border-line bg-paper p-4 text-left transition-[border-color,box-shadow,translate] duration-200 hover:-translate-y-0.5 hover:border-indigo/50 hover:shadow-(--shadow-lift) disabled:opacity-55"
    >
      <span className="text-ink-2 transition-colors group-hover:text-indigo">{icon}</span>
      <span className="mt-2.5 font-semibold text-ink">{title}</span>
      <span className="mt-0.5 text-sm text-ink-2">{about}</span>
      <span className="mt-3 flex items-start gap-1.5 border-t border-line pt-3 text-sm text-ink">
        <span className="flex-1">“{prompt}”</span>
        <ArrowIcon width={16} height={16} className="mt-0.5 shrink-0 text-ink-3 transition-[color,translate] group-hover:translate-x-0.5 group-hover:text-indigo" />
      </span>
    </button>
  );
}

/**
 * The first screen. Scanning a receipt is the product's best trick, so it is
 * the hero: one panel, one primary action, and the real sample receipt sitting
 * in it, ready to be tried with a click. The three other ways in follow, each
 * a real question that sends when pressed.
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

  return (
    <div className="@container mx-auto w-full max-w-2xl pt-7 pb-4 desk:pt-12">
      <h1 className="text-[2.5rem] leading-[1.05] font-semibold tracking-[-0.035em] sm:text-[3.25rem]">
        Snap. Chat. <span className="text-indigo">Submit.</span>
      </h1>
      <p className="mt-3 text-lg text-ink-2">Business expenses, without the paperwork.</p>

      <section
        aria-label="Scan a receipt"
        className="relative mt-7 flex overflow-hidden rounded-2xl border border-indigo/15 bg-indigo-wash"
      >
        <div className="relative z-10 min-w-0 flex-1 p-5 pr-28 @lg:p-7 @lg:pr-4">
          <span className="grid size-10 place-items-center rounded-xl bg-paper text-indigo shadow-(--shadow-lift)">
            <CameraIcon width={21} height={21} />
          </span>
          <h2 className="mt-4 text-xl font-semibold tracking-tight text-ink">Your receipt is all you need.</h2>
          <p className="mt-1 text-ink-2">
            Upload a photo. It becomes a draft you check against the original and submit when you are ready.
          </p>
          <div className="mt-5 flex flex-wrap items-center gap-x-5 gap-y-2">
            <button
              type="button"
              onClick={() => input.current?.click()}
              disabled={disabled}
              className="inline-flex min-h-11 items-center gap-2 rounded-lg bg-indigo px-4.5 font-medium text-white shadow-(--shadow-lift) transition-colors hover:bg-indigo-deep disabled:opacity-55"
            >
              <SlipIcon width={18} height={18} />
              Scan a receipt
            </button>
            <button
              type="button"
              onClick={onSample}
              disabled={disabled}
              className="group inline-flex min-h-11 items-center gap-1.5 rounded-lg font-medium text-indigo-deep disabled:opacity-55"
            >
              Try the sample
              <ArrowIcon width={16} height={16} className="transition-transform group-hover:translate-x-0.5" />
            </button>
          </div>
        </div>

        {/* The actual sample receipt, not a drawing of one. Pressing it tries it. */}
        <button
          type="button"
          onClick={onSample}
          disabled={disabled}
          aria-label="Try the sample receipt"
          title="Try the sample receipt"
          className="absolute -right-2 -bottom-14 w-32 rotate-6 overflow-hidden rounded-md border border-line bg-paper shadow-(--shadow-slip) transition-[rotate,translate] duration-300 ease-(--ease-out-expo) hover:-translate-y-2 hover:rotate-3 disabled:opacity-70 @lg:static @lg:my-6 @lg:mr-8 @lg:w-36 @lg:shrink-0 @lg:self-center @2xl:w-40"
        >
          <img src="/samples/receipt-cafe-aurora.png" alt="" className="block w-full" />
        </button>
      </section>

      <div className="mt-4 grid gap-3 @xl:grid-cols-3">
        <Start
          icon={<ShieldIcon width={22} height={22} />}
          title="Before you spend"
          about="Check a policy limit."
          prompt="Can I expense a $120 client dinner?"
          onPrompt={onPrompt}
          disabled={disabled}
        />
        <Start
          icon={<SlipIcon width={22} height={22} />}
          title="Report an expense"
          about="Describe what you spent."
          prompt="I spent $42 on lunch at Cafe Nero yesterday"
          onPrompt={onPrompt}
          disabled={disabled}
        />
        <Start
          icon={<BarsIcon width={22} height={22} />}
          title="Spending insights"
          about="Ask about what you submitted."
          prompt="How much have I spent this month?"
          onPrompt={onPrompt}
          disabled={disabled}
        />
      </div>

      <p className="mt-4 text-xs text-ink-3">
        A demo with fictional data and a fictional company policy. Please don't upload real receipts.
      </p>

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

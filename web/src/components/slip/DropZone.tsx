import { type DragEvent, useRef, useState } from "react";
import { useElapsed } from "../../state/hooks";
import { ReceiptPhoto, SlipButton } from "./Slip";

/** Reads the first image out of a drop or a file picker. */
export function firstImage(files: FileList | null | undefined): File | null {
  if (!files) return null;
  // The type is only a hint for the browser; the server decides what the file really is.
  return [...files].find((file) => file.type.startsWith("image/") || file.type === "") ?? null;
}

/** A line on the blank slip waiting to be written on. */
function Blank({ label }: { label: string }) {
  return (
    <div className="flex items-end gap-3">
      <span className="w-20 shrink-0 text-sm text-ink-3">{label}</span>
      <span className="mb-1 h-px flex-1 border-b border-dotted border-line-strong" aria-hidden="true" />
    </div>
  );
}

/**
 * The blank slip. It has the same anatomy as a filled one (status line, amount,
 * details, policy, actions), so when a receipt is read the values arrive where
 * the blanks were. It is also the upload target and the first thing a new
 * visitor sees, so it offers a way to try it without a file.
 */
export function DropZone({
  onFile,
  onSample,
  disabled,
}: {
  onFile: (file: File) => void;
  onSample: () => void;
  disabled: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);

  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    // Handled here; the workspace around the slip also accepts drops.
    event.stopPropagation();
    setOver(false);
    const file = firstImage(event.dataTransfer.files);
    if (file && !disabled) onFile(file);
  };

  return (
    <section
      aria-label="Blank slip. Start a new expense"
      onDragOver={(event) => {
        event.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={onDrop}
      className={`slip slip-draft transition-colors ${over ? "border-indigo bg-indigo-wash" : ""}`}
    >
      <div className="flex items-center justify-between gap-3 border-b border-line px-5 py-2.5 text-sm">
        <h3 className="font-semibold text-ink">{over ? "Drop it on the slip" : "Ready for your receipt"}</h3>
      </div>

      <div className="space-y-3.5 px-5 pt-5 pb-5">
        <div className="flex items-end gap-2" aria-hidden="true">
          <span className="figure text-[2rem] leading-none font-medium text-line-strong">$</span>
          <span className="mb-1 h-px w-32 border-b border-dotted border-line-strong" />
        </div>
        <Blank label="Merchant" />
        <Blank label="Date" />
        <Blank label="Category" />
      </div>

      <div className="border-t border-line px-5 py-4">
        <div className="flex items-baseline justify-between text-sm text-ink-3">
          <span>Policy check</span>
          <span>appears with the amount</span>
        </div>
        <div className="mt-2 h-2.5 rounded-full bg-desk-deep" aria-hidden="true" />
      </div>

      <div className="px-5 pt-1 pb-4">
        <p className="hidden py-2 text-center text-sm font-medium text-ink-2 desk:block">Drop your receipt here</p>
        <div className="flex flex-wrap gap-2.5 desk:hidden">
          <SlipButton primary onClick={() => input.current?.click()} disabled={disabled}>
            Choose a photo
          </SlipButton>
          <SlipButton onClick={onSample} disabled={disabled}>
            Use the sample receipt
          </SlipButton>
        </div>
        <p className="mt-2.5 text-xs text-ink-3">
          JPEG or PNG. A photo is read once and never stored. Demo with fictional data: please don't upload real
          receipts.
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
    </section>
  );
}

/** A button that opens the camera or photo library and hands back the chosen image. */
export function ScanButton({
  children,
  onFile,
  disabled,
}: {
  children: string;
  onFile: (file: File) => void;
  disabled: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <SlipButton primary onClick={() => input.current?.click()} disabled={disabled}>
        {children}
      </SlipButton>
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
    </>
  );
}

/**
 * The slip while its receipt is being read. One true statement about what is
 * happening, how long it has taken, and placeholders where the values will be.
 */
export function SlipReading({ photo, startedAt }: { photo: string | null; startedAt: number }) {
  const seconds = useElapsed(startedAt);
  return (
    <section aria-label="Reading your receipt" aria-busy="true" className="slip slip-draft">
      <div className="flex items-center justify-between gap-3 border-b border-line px-5 py-2.5 text-sm">
        <span className="font-medium">Reading your receipt…</span>
        <span className="text-ink-3 tabular-nums">{Math.floor(seconds)}s</span>
      </div>
      <div className="flex gap-4 px-5 pt-4 pb-5">
        <ReceiptPhoto src={photo} />
        <div className="flex-1 space-y-3 pt-1">
          <div className="skeleton h-8 w-32" />
          <div className="skeleton h-4 w-40" />
          <div className="skeleton h-3.5 w-48 max-w-full" />
        </div>
      </div>
      <div className="border-t border-line px-5 py-4">
        <div className="skeleton h-2.5 rounded-full" />
      </div>
      <p className="px-5 pb-4 text-sm text-ink-2" role="status">
        {seconds >= 8
          ? "The free AI service is busy right now. Still working on it."
          : "One request to the AI service. This usually takes a few seconds."}
      </p>
    </section>
  );
}

import { type FormEvent, type KeyboardEvent, useEffect, useRef, useState } from "react";
import { AttachIcon, SendIcon } from "../Icons";
import { firstImage } from "../slip/DropZone";

/**
 * Where the user talks to the slip. Enter sends, Shift+Enter adds a line, and
 * the attach button sends a receipt photo (with whatever is typed as its note).
 *
 * `seed` is text placed here by something else on the page (tapping a field on
 * the slip, for example) for the user to finish.
 */
export function MessageComposer({
  onSend,
  onFile,
  disabled,
  seed,
  onSeedUsed,
  placeholder,
}: {
  onSend: (text: string) => void;
  onFile: (file: File, caption: string) => void;
  disabled: boolean;
  seed: { text: string; key: number } | null;
  onSeedUsed: () => void;
  placeholder: string;
}) {
  const [text, setText] = useState("");
  const field = useRef<HTMLTextAreaElement>(null);
  const file = useRef<HTMLInputElement>(null);

  // Grow with the text, up to about six lines.
  useEffect(() => {
    const element = field.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, 168)}px`;
  }, [text]);

  useEffect(() => {
    if (!seed) return;
    setText(seed.text);
    onSeedUsed();
    requestAnimationFrame(() => {
      const element = field.current;
      if (!element) return;
      element.focus();
      element.setSelectionRange(seed.text.length, seed.text.length);
    });
  }, [seed, onSeedUsed]);

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    if (disabled || text.trim() === "") return;
    onSend(text);
    setText("");
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submit();
    }
  };

  const canSend = !disabled && text.trim() !== "";

  return (
    <form
      onSubmit={submit}
      className="flex items-end gap-1 rounded-2xl border border-line-strong bg-paper p-1.5 transition-colors focus-within:border-indigo"
    >
      <button
        type="button"
        onClick={() => file.current?.click()}
        disabled={disabled}
        aria-label="Attach a receipt photo"
        title="Attach a receipt photo"
        className="grid size-11 shrink-0 place-items-center rounded-xl text-ink-2 transition-colors hover:bg-desk hover:text-ink disabled:opacity-50"
      >
        <AttachIcon />
      </button>

      <label htmlFor="composer" className="sr-only">
        Message
      </label>
      <textarea
        id="composer"
        ref={field}
        rows={1}
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        maxLength={2000}
        className="min-h-11 flex-1 resize-none bg-transparent px-1.5 py-2.5 text-base text-ink outline-none placeholder:text-ink-3"
      />

      <button
        type="submit"
        disabled={!canSend}
        aria-label="Send"
        title="Send"
        className="grid size-11 shrink-0 place-items-center rounded-xl bg-indigo text-white transition-colors hover:bg-indigo-deep disabled:bg-desk-deep disabled:text-ink-3"
      >
        <SendIcon />
      </button>

      <input
        ref={file}
        type="file"
        accept="image/*"
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        onChange={(event) => {
          const image = firstImage(event.target.files);
          if (image) {
            onFile(image, text);
            setText("");
          }
          event.target.value = "";
        }}
      />
    </form>
  );
}

import type { SelectHTMLAttributes } from "react";

/**
 * A native select (keyboard, screen reader and phone pickers all work as
 * people expect) with the app's own outline and chevron instead of the
 * browser's.
 */
export function Select({ className = "", children, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <span className="relative inline-flex">
      <select
        {...props}
        className={`min-h-11 appearance-none rounded-lg border border-line-strong bg-paper py-2 pr-9 pl-3 text-base text-ink transition-colors hover:border-ink-3 ${className}`}
      >
        {children}
      </select>
      <svg
        width="16"
        height="16"
        viewBox="0 0 20 20"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-ink-2"
      >
        <path d="m5.5 8 4.5 4.5L14.5 8" />
      </svg>
    </span>
  );
}

# Expenso design system

Recorded from the built app. Tokens live in `src/index.css`; this file explains them.

## The world

White slips of paper on a cool desk, written and stamped in indigo ink.

An expense is a **slip**: one object, pinned beside the conversation, that the conversation
changes. The interface is flat. The only tactile ideas are the ones that carry meaning:

| State | Form |
|---|---|
| Draft | Dashed outline, perforated bottom edge, the words "Draft · not submitted" |
| Submitted | Solid outline, clean edge, an indigo **SUBMITTED** stamp with the date |
| Needs review | As submitted, plus an amber **NEEDS REVIEW** stamp |
| Receipt waiting for details | Draft form, with a list of what was read and what is missing |

Policy is a **limit ruler**: the amount drawn against the category limit, hatched amber
past the limit mark, with quarter marks, the limit's value at its mark, and a sentence. It appears on slips, in policy answers in
the conversation, and on the policy page.

## Colour

Restrained: tinted neutrals and one accent. All values are OKLCH with a shared hue (268–272).

| Token | Use |
|---|---|
| `desk`, `desk-deep` | Page ground; the desk pane and quiet fills |
| `paper` | Slips, the top bar, inputs |
| `line`, `line-strong` | Hairlines; control outlines and dashed slip edges |
| `ink`, `ink-2`, `ink-3` | Text: primary, secondary, tertiary/placeholder (all ≥ 4.5:1 on desk and paper) |
| `indigo`, `indigo-deep`, `indigo-wash` | Primary action, focus ring, active navigation, the submitted stamp, "just changed" highlight |
| `ok` | "Within policy" only |
| `review`, `review-wash`, `review-line` | Over the limit: ruler hatch, review stamp, review text |
| `stop`, `stop-wash` | Errors and "can't be submitted" |

Green, amber and red never appear without words next to them.

## Type

- **Geist** (variable, self-hosted) for all interface text. One family; 400 for text, 500
  for controls, 600 for headings, 700 for the wordmark.
- **Geist Mono** for money (`.figure`, tabular figures) and for the ink stamp, which is a
  printed mark. Dates, slip numbers and timers use the sans with `tabular-nums`.
- Fixed rem scale: 11, 12, 13, 15 (body), 17, 20, 24, 32. The slip amount is 32px and is
  the largest thing on the desk; the welcome heading is 52px (40px on phones).
- Prose is capped at 62ch.

## Shape and depth

- Radius: 10px slips, 8px buttons and inputs, 16px the composer.
- 1px hairline borders. Depth is used for two things only: paper lying on the desk
  (`--shadow-slip`, on slips and the sample receipt) and a control or panel lifting
  (`--shadow-lift`: the composer, hero button, popovers, summary panels).
- The conversation pane is white paper; the desk beside it is the tinted ground.
- Cards exist only where the content is a discrete object (a slip, a policy check, a
  summary). No card inside a card.

## Components

- `Slip` (`components/slip/Slip.tsx`): shell, status line, body with optional receipt
  photo, tappable fields, buttons. `ExpenseDraftCard`, `ReceiptAnalysisCard` and
  `ExpenseSubmissionConfirmation` are its three states.
- `DropZone` / `SlipReading`: the blank slip (same anatomy as a filled one, with ruled
  blanks; also the upload target) and the slip while a receipt is being read.
- `LimitRuler`, `PolicyStatus`, `PolicyCheck`.
- `Ledger`, `SpendingSummary` (one stacked bar in steps of neutral ink, with a legend that
  names every segment). Indigo is not used here.
- `Message`, `EventLine`: the assistant's text reads like a document; the user's messages
  are quiet chips on the right; what happened to a slip is a one-line event.
- `MessageComposer`, `Welcome`, `WorkingIndicator`, `ErrorState`.
- Buttons come in two shapes everywhere: filled indigo (the one primary action) and
  outlined. Minimum height 44px.

## Motion

One authored moment: the stamp landing on the slip (420ms, exponential ease-out, slight
blur and scale). Everything else is a state change at 150–300ms: messages settling in,
a changed value flashing indigo wash, the ruler moving, the ledger total counting up to
its new backend value. All of it is disabled under `prefers-reduced-motion`.

## Layout

- ≥ 768px: conversation (fluid, content capped at 42rem) and desk (20–27rem) side by
  side; navigation in the top bar.
- Below that: one pane at a time, with a bottom tab bar (Assistant, Desk, Expenses,
  Policy). A compact bar above the composer keeps a pending slip and its Confirm in reach.

## Brand

The mark is the full stop: an indigo square holding "e.", beside the lowercase wordmark
"expenso." with its stop in indigo. It is the same stop that ends "Snap. Chat. Submit."
The assistant signs its lines in the conversation with the small mark.

## First screen

Scanning a receipt is the hero: one indigo-wash panel with the primary action ("Scan a
receipt"), "Try the sample", and the real sample receipt image, tilted, which is itself a
button. Three secondary ways in follow as tiles, each a real question that sends on click.
The layout responds to the width of the conversation pane (container queries), not the window.

## Voice

Plain and specific. Controls name their action ("Confirm and submit", "Discard", "Use the
sample receipt"). Status lines say exactly what is true ("Draft · not submitted",
"Submitted for processing"). Errors name the problem and the way forward. "Submitted"
is never called "approved". Progress is one true statement with the real elapsed time.

## Icons

Eleven icons drawn for this app on a 20px grid with a 1.6px stroke (`components/Icons.tsx`).
They mark actions and states only. No emoji, no decorative icons.

import { describe, expect, it } from "vitest";
import type { Bootstrap, ChatMessageDto, DeskState, ExpenseDto, TurnResult } from "../../shared/contract";
import { changedFields } from "../src/lib/diff";
import { day, describeChange, money, month, receiptAmount } from "../src/lib/format";
import { type State, initialState, reducer } from "../src/state/reducer";

const expense = (overrides: Partial<ExpenseDto> = {}): ExpenseDto => ({
  id: 1,
  amountCents: 4200,
  category: "meals",
  merchant: "Cafe Nero",
  expenseDate: "2026-11-23",
  description: null,
  status: "draft",
  policyResult: "within_policy",
  policyNotes: null,
  createdAt: "2026-11-24 10:00:00",
  submittedAt: null,
  ...overrides,
});

const desk = (overrides: Partial<DeskState> = {}): DeskState => ({
  currentSlip: null,
  pendingReceipt: null,
  month: { from: "2026-11-01", to: "2026-11-24", summary: { totalCents: 0, count: 0, needsReviewCount: 0, byCategory: [] } },
  recent: [],
  limits: { meals: 7500, travel: 50000, lodging: 30000, software: 10000, office: 15000, other: 5000 },
  ...overrides,
});

const message = (id: number, overrides: Partial<ChatMessageDto> = {}): ChatMessageDto => ({
  id,
  role: "assistant",
  text: "ok",
  createdAt: "2026-11-24 10:00:00",
  ...overrides,
});

const ready = (overrides: Partial<State> = {}): State => ({ ...initialState, status: "ready", desk: desk(), ...overrides });
const sending = { kind: "sending" as const, startedAt: 0 };

describe("reducer", () => {
  it("shows the user's message at once and clears it when the server's version arrives", () => {
    const started = reducer(ready(), { type: "turn_started", turn: sending, outgoing: { text: "hello" } });
    expect(started.outgoing).toEqual({ text: "hello" });

    const result: TurnResult = { messages: [message(1, { role: "user", text: "hello" }), message(2)], desk: desk() };
    const finished = reducer(started, { type: "turn_finished", result });

    expect(finished.outgoing).toBeNull();
    expect(finished.turn).toEqual({ kind: "idle" });
    expect(finished.messages.map((m) => m.id)).toEqual([1, 2]);
  });

  it("never adds the same message twice", () => {
    const state = ready({ messages: [message(1)] });
    const finished = reducer(state, { type: "turn_finished", result: { messages: [message(1), message(2)], desk: desk() } });
    expect(finished.messages.map((m) => m.id)).toEqual([1, 2]);
  });

  it("highlights exactly the fields that changed when the slip is replaced", () => {
    const state = ready({ desk: desk({ currentSlip: expense({ id: 1 }) }) });
    const result: TurnResult = { messages: [], desk: desk({ currentSlip: expense({ id: 2, amountCents: 4850 }) }) };

    const finished = reducer(state, { type: "turn_finished", result });

    expect(finished.highlight.fields).toEqual(["amount"]);
    expect(finished.highlight.key).toBe(state.highlight.key + 1);
  });

  it("keeps the stamped slip on the desk after a confirmation, until the next slip arrives", () => {
    const filed = expense({ id: 3, status: "submitted", submittedAt: "2026-11-24T10:00:00.000Z" });
    const state = ready({ desk: desk({ currentSlip: expense({ id: 3 }) }), turn: { kind: "confirming", startedAt: 0 } });
    const confirmed = reducer(state, {
      type: "turn_finished",
      result: { messages: [message(5, { card: { kind: "expense", event: "submitted", expense: filed } })], desk: desk({ recent: [filed] }) },
    });
    expect(confirmed.filed?.id).toBe(3);

    const next = reducer(confirmed, { type: "turn_finished", result: { messages: [], desk: desk({ currentSlip: expense({ id: 4 }) }) } });
    expect(next.filed).toBeNull();
  });

  it("remembers the photo of a receipt against the stored message, for this visit only", () => {
    const started = reducer(ready(), {
      type: "turn_started",
      turn: { kind: "reading_receipt", startedAt: 0 },
      outgoing: { text: "", receiptPreview: "blob:receipt" },
    });
    expect(started.slipPreview).toBe("blob:receipt");

    const finished = reducer(started, {
      type: "turn_finished",
      result: {
        messages: [message(7, { role: "user", text: "", attachment: "receipt_photo" }), message(8)],
        desk: desk({ currentSlip: expense({ id: 9 }) }),
      },
    });

    expect(finished.receiptPreviews).toEqual({ 7: "blob:receipt" });
    expect(finished.slipPreview).toBe("blob:receipt");
  });

  it("drops the photo once nothing on the desk belongs to it", () => {
    const state = ready({ slipPreview: "blob:receipt", desk: desk({ currentSlip: expense() }), turn: { kind: "cancelling", startedAt: 0 } });
    const finished = reducer(state, { type: "turn_finished", result: { messages: [], desk: desk() } });
    expect(finished.slipPreview).toBeNull();
  });

  it("does not show an earlier receipt's photo on a draft that was typed afterwards", () => {
    const filed = expense({ id: 3, status: "submitted" });
    const state = ready({ slipPreview: "blob:old-receipt", filed, desk: desk({ recent: [filed] }), turn: sending });

    const finished = reducer(state, { type: "turn_finished", result: { messages: [], desk: desk({ currentSlip: expense({ id: 4 }) }) } });

    expect(finished.slipPreview).toBeNull();
  });

  it("surfaces a refusal that the server did not store", () => {
    const finished = reducer(ready({ turn: sending }), {
      type: "turn_finished",
      result: { messages: [], desk: desk(), notice: { code: "invalid_image", message: "I can only read JPEG or PNG." } },
    });
    expect(finished.notice).toBe("I can only read JPEG or PNG.");
  });

  it("offers a retry when a request got no answer and the server never saw it", () => {
    const state = ready({ messages: [message(1)], turn: sending, outgoing: { text: "hello" } });
    const bootstrap: Bootstrap = { messages: [message(1)], desk: desk() };

    const lost = reducer(state, { type: "turn_lost", bootstrap, message: "No connection." });

    expect(lost.failed).toEqual({ message: "No connection." });
    expect(lost.outgoing).toEqual({ text: "hello" });
  });

  it("does not offer a retry when the lost request turns out to have arrived", () => {
    const state = ready({ messages: [message(1)], turn: sending, outgoing: { text: "hello" } });
    const bootstrap: Bootstrap = { messages: [message(1), message(2), message(3)], desk: desk({ currentSlip: expense() }) };

    const lost = reducer(state, { type: "turn_lost", bootstrap, message: "No connection." });

    expect(lost.failed).toBeNull();
    expect(lost.outgoing).toBeNull();
    expect(lost.messages).toHaveLength(3);
    expect(lost.desk?.currentSlip).not.toBeNull();
  });

  it("gives each composer seed a new key so the same text can be seeded twice", () => {
    const once = reducer(ready(), { type: "seed", text: "Change the amount to $" });
    const twice = reducer(reducer(once, { type: "seed_used" }), { type: "seed", text: "Change the amount to $" });
    expect(twice.seed?.text).toBe("Change the amount to $");
    expect(twice.seed?.key).toBe(1);
  });
});

describe("changedFields", () => {
  it("is empty for the same slip, a first slip, or no slip", () => {
    expect(changedFields(expense(), expense())).toEqual([]);
    expect(changedFields(null, expense())).toEqual([]);
    expect(changedFields(expense(), null)).toEqual([]);
  });

  it("lists every field that differs", () => {
    const after = expense({ id: 2, merchant: "Cafe Aurora", expenseDate: "2026-11-22", category: "travel", description: "x" });
    expect(changedFields(expense(), after)).toEqual(["merchant", "date", "category", "description"]);
  });
});

describe("formatting", () => {
  it("formats cents as dollars", () => {
    expect(money(4850)).toBe("$48.50");
    expect(money(123456789)).toBe("$1,234,567.89");
  });

  it("formats dates without shifting them across timezones", () => {
    expect(day("2026-11-23")).toBe("23 Nov 2026");
    expect(day("2026-01-01")).toBe("1 Jan 2026");
    expect(month("2026-11-01")).toBe("November 2026");
  });

  it("describes a change in plain words", () => {
    expect(describeChange({ field: "amount", from: "$42.00", to: "$48.50" })).toBe("Amount changed $42.00 → $48.50");
    expect(describeChange({ field: "date", from: "2026-11-23", to: "2026-11-22" })).toBe("Date changed 23 Nov 2026 → 22 Nov 2026");
    expect(describeChange({ field: "description", from: "", to: "Client lunch" })).toBe("Note added: Client lunch");
  });

  it("writes a dollar sign only for a confirmed USD amount", () => {
    const fields = { merchant: null, amountCents: 4850, currency: null, expenseDate: null, category: null, description: null };
    expect(receiptAmount({ ...fields, currency: "USD" })).toBe("$48.50");
    expect(receiptAmount({ ...fields, currency: "EUR" })).toBe("48.50 EUR");
    expect(receiptAmount(fields)).toBe("48.50");
    expect(receiptAmount({ ...fields, amountCents: null })).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import { ValidationError } from "../src/lib/errors";
import { formatCents, toCents } from "../src/lib/money";

describe("toCents", () => {
  it.each([
    [42, 4200],
    [42.5, 4250],
    [0.01, 1],
    [19.99, 1999],
    [1.1, 110],
    [0.07, 7],
    ["42", 4200],
    ["42.50", 4250],
    [" 12.3 ", 1230],
  ])("converts %j dollars to %i cents", (input, expected) => {
    expect(toCents(input)).toBe(expected);
  });

  it.each([
    ["fractions of a cent", 10.005],
    ["zero", 0],
    ["a negative amount", -5],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["text", "abc"],
    ["an empty string", ""],
    ["a currency symbol", "$12"],
    ["scientific notation", "1e3"],
    ["null", null],
    ["an object", {}],
  ])("rejects %s", (_label, input) => {
    expect(() => toCents(input)).toThrow(ValidationError);
  });
});

describe("formatCents", () => {
  it.each([
    [4200, "$42.00"],
    [1, "$0.01"],
    [123456789, "$1,234,567.89"],
  ])("formats %i cents as %s", (cents, expected) => {
    expect(formatCents(cents)).toBe(expected);
  });
});

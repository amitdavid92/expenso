/**
 * Thrown when input fails validation at a service boundary. `issues` are
 * human-readable and safe to show to the user (or hand back to the model).
 */
export class ValidationError extends Error {
  readonly issues: string[];

  constructor(issues: string | string[]) {
    const list = Array.isArray(issues) ? issues : [issues];
    super(list.join(" "));
    this.name = "ValidationError";
    this.issues = list;
  }
}

/** Guards database ids (and similar) arriving from outside the service layer. */
export function assertPositiveInt(value: unknown, name: string): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new ValidationError(`${name} must be a positive whole number.`);
  }
}

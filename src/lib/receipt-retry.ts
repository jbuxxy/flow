// How many times one email may come back missing from an otherwise good
// AI extraction response before Flow stops sending it. Each retry is a
// billed call, and the cursor holds on that email until it resolves — so
// one message the model always skips would otherwise be re-sent every
// 20-minute sync forever (2026-10-20).
export const MAX_OMITTED_ATTEMPTS = 3;

// In-memory, per container: a restart grants a stuck email at most
// MAX_OMITTED_ATTEMPTS more tries, which keeps the worst case bounded
// without a schema column for what is otherwise a rare, transient state.
// Only omissions count — a call that failed outright (quota, outage) says
// nothing about the email and was never billed.
export class OmissionTracker {
  private attempts = new Map<string, number>();
  private readonly max: number;

  // A plain field, not a parameter property — the test runner strips types
  // only and rejects that syntax.
  constructor(max = MAX_OMITTED_ATTEMPTS) {
    this.max = max;
  }

  // Records one more omission; true once the email should be given up on.
  omitted(key: string): boolean {
    const n = (this.attempts.get(key) ?? 0) + 1;
    if (n >= this.max) {
      this.attempts.delete(key);
      return true;
    }
    this.attempts.set(key, n);
    return false;
  }

  resolved(key: string): void {
    this.attempts.delete(key);
  }
}

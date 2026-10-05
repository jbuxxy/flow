const CENTS_PER_DOLLAR = 100;

export function dollarsToCents(dollars: number): number {
  return Math.round(dollars * CENTS_PER_DOLLAR);
}

export function centsToDollars(cents: number): number {
  return cents / CENTS_PER_DOLLAR;
}

const formatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
});

export function formatCents(cents: number): string {
  return formatter.format(centsToDollars(cents));
}

const wholeDollarFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

// Whole-dollar display — used where the exact cents are noise rather than
// signal (bucket caps + spend on the /buckets list, the caps-vs-income
// summary). The stored value stays in cents; this only rounds the string.
export function formatDollars(cents: number): string {
  return wholeDollarFormatter.format(Math.round(centsToDollars(cents)));
}

// Parses a user-entered dollar string ("1,234.56", "$45", "45.5") into
// integer cents. Returns null if it isn't a valid non-negative amount.
export function parseDollarsToCents(input: string): number | null {
  const cleaned = input.replace(/[$,]/g, "").trim();
  if (!cleaned) return null;
  const value = Number(cleaned);
  if (!Number.isFinite(value) || value < 0) return null;
  return dollarsToCents(value);
}

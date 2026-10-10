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

// A form's optional tolerance field: blank -> null ("use the default
// amountToleranceCents heuristic"), a valid non-negative dollar amount ->
// cents, anything else -> not ok.
export function parseOptionalToleranceCents(tolerance: string | undefined): { ok: true; value: number | null } | { ok: false } {
  if (!tolerance) return { ok: true, value: null };
  const cents = parseDollarsToCents(tolerance);
  if (cents === null || cents < 0) return { ok: false };
  return { ok: true, value: cents };
}

// A percent field ("19.99", "19.99%") -> basis points, or null when it
// isn't a valid 0–100 rate. Shared by every APR/APY form.
export function parsePercentToBasisPoints(input: string): number | null {
  const value = Number(input.replace(/%/g, "").trim());
  if (!Number.isFinite(value) || value < 0 || value > 100) return null;
  return Math.round(value * 100);
}

// Basis points -> "19.99%".
export function formatBasisPoints(basisPoints: number): string {
  return `${(basisPoints / 100).toFixed(2)}%`;
}

// A /transactions "$ min"/"$ max" URL param -> cents (undefined when blank or
// not a number). Shared by the filter form and the page's own query so the
// two can't read the same param differently.
export function parseAmountParamCents(param: string | undefined): number | undefined {
  if (!param) return undefined;
  const dollars = parseFloat(param);
  return Number.isFinite(dollars) ? dollarsToCents(dollars) : undefined;
}


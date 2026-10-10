// Shared y-axis helpers for the SVG charts (payoff projection, net worth
// trend, spending trend).

// Compact axis tick text ($1.2M / $800K / -$40K) — formatCents' full
// "$1,234.56" is too wide to repeat 4-5 times up a 52px-wide axis gutter.
export function formatCompact(cents: number): string {
  const dollars = cents / 100;
  const sign = dollars < 0 ? "-" : "";
  const abs = Math.abs(dollars);
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(abs >= 10_000_000 ? 0 : 1)}M`;
  if (abs >= 1_000) return `${sign}$${Math.round(abs / 1_000)}K`;
  return `${sign}$${Math.round(abs)}`;
}

// ~4 evenly-spaced, round-number ticks spanning [min, max] — the classic
// "nice numbers" step (1/2/5 × a power of 10), so an axis reads 0 / 200K /
// 400K rather than whatever the raw min/max happen to be.
export function niceTicks(min: number, max: number, count = 4): number[] {
  if (min === max) return [min];
  const rawStep = (max - min) / count;
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const residual = rawStep / magnitude;
  const step = (residual >= 5 ? 10 : residual >= 2 ? 5 : residual >= 1 ? 2 : 1) * magnitude;
  const niceMin = Math.floor(min / step) * step;
  const niceMax = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let v = niceMin; v <= niceMax + step / 2; v += step) ticks.push(Math.round(v));
  return ticks;
}

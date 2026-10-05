// Categorical palette, same fixed hue order as the dataviz skill's validated
// default (blue/orange/emerald/amber/violet) — expressed as Tailwind classes
// to match every other chart/UI color in this codebase (net-worth-trend-chart,
// payoff-projection-chart, etc. all use `dark:` variant classes, not inline
// hex). A chart with more series than slots folds the rest into "Other"
// rather than generating a new hue.
export const SERIES_COLORS = [
  { stroke: "stroke-blue-600 dark:stroke-blue-400", fill: "bg-blue-600 dark:bg-blue-400", dot: "bg-blue-600 dark:bg-blue-400" },
  { stroke: "stroke-orange-600 dark:stroke-orange-400", fill: "bg-orange-600 dark:bg-orange-400", dot: "bg-orange-600 dark:bg-orange-400" },
  { stroke: "stroke-emerald-600 dark:stroke-emerald-400", fill: "bg-emerald-600 dark:bg-emerald-400", dot: "bg-emerald-600 dark:bg-emerald-400" },
  { stroke: "stroke-amber-500 dark:stroke-amber-400", fill: "bg-amber-500 dark:bg-amber-400", dot: "bg-amber-500 dark:bg-amber-400" },
  { stroke: "stroke-violet-600 dark:stroke-violet-400", fill: "bg-violet-600 dark:bg-violet-400", dot: "bg-violet-600 dark:bg-violet-400" },
];
export const OTHER_COLOR = {
  stroke: "stroke-neutral-500 dark:stroke-neutral-400",
  fill: "bg-neutral-500 dark:bg-neutral-400",
  dot: "bg-neutral-500 dark:bg-neutral-400",
};

// A wider fixed-hue set for per-debt line charts, where the household
// explicitly wants every debt named rather than folded into "Other" — still
// a hand-picked palette, not a generated one, just a longer one than the
// 5-slot categorical default above.
export const LINE_SERIES_COLORS = [
  ...SERIES_COLORS,
  { stroke: "stroke-pink-600 dark:stroke-pink-400", fill: "bg-pink-600 dark:bg-pink-400", dot: "bg-pink-600 dark:bg-pink-400" },
  { stroke: "stroke-teal-600 dark:stroke-teal-400", fill: "bg-teal-600 dark:bg-teal-400", dot: "bg-teal-600 dark:bg-teal-400" },
  { stroke: "stroke-red-600 dark:stroke-red-400", fill: "bg-red-600 dark:bg-red-400", dot: "bg-red-600 dark:bg-red-400" },
  { stroke: "stroke-indigo-600 dark:stroke-indigo-400", fill: "bg-indigo-600 dark:bg-indigo-400", dot: "bg-indigo-600 dark:bg-indigo-400" },
  { stroke: "stroke-lime-600 dark:stroke-lime-400", fill: "bg-lime-600 dark:bg-lime-400", dot: "bg-lime-600 dark:bg-lime-400" },
];
export const TOTAL_COLOR = {
  stroke: "stroke-neutral-900 dark:stroke-neutral-100",
  fill: "bg-neutral-900 dark:bg-neutral-100",
  dot: "bg-neutral-900 dark:bg-neutral-100",
};

// Subtle wireframe-triangle decoration for the auth screens (login,
// register, setup-totp) — a sparse network of hairline segments/nodes
// clustered in two opposite corners, matching the brand splash art. Uses
// `currentColor` so a single Tailwind text-color class themes it for
// light/dark/system all at once; stroke-only, no fill, so it never
// competes with foreground content. Purely decorative: aria-hidden,
// pointer-events-none, absolutely positioned behind the page's real
// content (render it first, then position children with `relative`).
const CLUSTER = [
  ["89.0", "178.0", "254.5", "97.8"],
  ["422.5", "1.4", "406.1", "16.5"],
  ["287.2", "243.0", "248.8", "254.3"],
  ["422.5", "1.4", "418.8", "50.6"],
  ["219.7", "1.0", "313.0", "4.8"],
  ["403.9", "-2.8", "402.1", "18.7"],
  ["313.0", "4.8", "403.9", "-2.8"],
  ["310.5", "203.8", "261.8", "246.1"],
  ["186.2", "11.3", "254.5", "97.8"],
  ["313.0", "4.8", "402.1", "18.7"],
  ["418.8", "50.6", "402.1", "18.7"],
  ["406.1", "16.5", "402.1", "18.7"],
  ["287.2", "243.0", "261.8", "246.1"],
  ["406.1", "16.5", "403.9", "-2.8"],
  ["287.2", "243.0", "211.1", "335.7"],
  ["410.9", "148.3", "402.1", "18.7"],
  ["219.7", "1.0", "186.2", "11.3"],
  ["310.5", "203.8", "287.2", "243.0"],
  ["313.0", "4.8", "186.2", "11.3"],
  ["310.5", "203.8", "410.9", "148.3"],
  ["248.8", "254.3", "261.8", "246.1"],
  ["89.0", "178.0", "248.8", "254.3"],
  ["248.8", "254.3", "211.1", "335.7"],
  ["422.5", "1.4", "403.9", "-2.8"],
  ["422.5", "1.4", "402.1", "18.7"],
  ["406.1", "16.5", "418.8", "50.6"],
  ["261.8", "246.1", "211.1", "335.7"],
  ["219.7", "1.0", "254.5", "97.8"],
  ["410.9", "148.3", "418.8", "50.6"],
  ["310.5", "203.8", "248.8", "254.3"],
  ["313.0", "4.8", "254.5", "97.8"],
  ["89.0", "178.0", "261.8", "246.1"],
] as const;

const NODES = [
  ["219.7", "1.0"],
  ["310.5", "203.8"],
  ["313.0", "4.8"],
  ["422.5", "1.4"],
  ["406.1", "16.5"],
  ["287.2", "243.0"],
  ["89.0", "178.0"],
  ["248.8", "254.3"],
  ["410.9", "148.3"],
  ["261.8", "246.1"],
  ["186.2", "11.3"],
  ["403.9", "-2.8"],
  ["254.5", "97.8"],
  ["418.8", "50.6"],
  ["402.1", "18.7"],
  ["211.1", "335.7"],
] as const;

function Cluster() {
  return (
    <>
      {CLUSTER.map(([x1, y1, x2, y2], i) => (
        <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} strokeWidth="1.25" />
      ))}
      {NODES.map(([cx, cy], i) => (
        <circle key={i} cx={cx} cy={cy} r="2.2" fill="currentColor" stroke="none" />
      ))}
    </>
  );
}

export function GeometricBackground({ className = "" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 1000 1000"
      preserveAspectRatio="none"
      aria-hidden="true"
      className={`pointer-events-none absolute inset-0 h-full w-full text-blue-900/[0.07] dark:text-blue-200/[0.06] ${className}`}
    >
      <g fill="none" stroke="currentColor">
        <g transform="translate(580,0)">
          <Cluster />
        </g>
        <g transform="translate(0,580) rotate(180,210,210)">
          <Cluster />
        </g>
      </g>
    </svg>
  );
}

import { db } from "@/lib/db";

// Per-feature totals from AiUsage (one row per provider call — see
// recordAiUsage in ai-provider.ts) for the /settings/ai usage card.
export type AiUsageFeatureTotals = {
  feature: string;
  calls: number;
  failed: number;
  inputTokens: number;
  outputTokens: number;
  thinkingTokens: number;
};

export type AiUsageSummary = {
  // "Last 30 Days", or "Since Oct 20" while the oldest row is younger than
  // the window (tracking only started 2026-10-20). Built here, not in the
  // client card, so server and client render the same date.
  windowLabel: string;
  features: AiUsageFeatureTotals[];
};

export async function getAiUsageSummary(householdId: string, days = 30): Promise<AiUsageSummary> {
  const from = new Date(Date.now() - days * 86_400_000);
  const rows = await db.aiUsage.groupBy({
    by: ["feature", "ok"],
    where: { householdId, createdAt: { gte: from } },
    _count: { _all: true },
    _sum: { inputTokens: true, outputTokens: true, thinkingTokens: true },
    _min: { createdAt: true },
  });

  const byFeature = new Map<string, AiUsageFeatureTotals>();
  let since: Date | null = null;
  for (const r of rows) {
    const t = byFeature.get(r.feature) ?? {
      feature: r.feature,
      calls: 0,
      failed: 0,
      inputTokens: 0,
      outputTokens: 0,
      thinkingTokens: 0,
    };
    t.calls += r._count._all;
    if (!r.ok) t.failed += r._count._all;
    t.inputTokens += r._sum.inputTokens ?? 0;
    t.outputTokens += r._sum.outputTokens ?? 0;
    t.thinkingTokens += r._sum.thinkingTokens ?? 0;
    byFeature.set(r.feature, t);
    const first = r._min.createdAt;
    if (first && (!since || first < since)) since = first;
  }

  const total = (t: AiUsageFeatureTotals) => t.inputTokens + t.outputTokens + t.thinkingTokens;
  const windowLabel =
    since && since > new Date(from.getTime() + 86_400_000)
      ? `Since ${since.toLocaleDateString("en-US", { month: "short", day: "numeric" })}`
      : `Last ${days} Days`;
  return {
    windowLabel,
    features: [...byFeature.values()].sort((a, b) => total(b) - total(a) || b.calls - a.calls),
  };
}

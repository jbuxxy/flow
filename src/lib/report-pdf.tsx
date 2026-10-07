import { Document, Page, Text, View, StyleSheet, renderToBuffer } from "@react-pdf/renderer";
import { formatCents } from "@/lib/money";
import { GOAL_POSTURE_LABEL } from "@/lib/goal-posture";
import type { ReportFindings } from "@/lib/ai";
import type { Report } from "@prisma/client";

// @react-pdf/renderer, not puppeteer/playwright — pure-JS layout, no
// headless Chromium binary to bundle into this single minimal container.
// Renders straight from a persisted Report row (findings + narrative), so an
// archived report's PDF never depends on anything that could have changed
// since (buckets renamed/deleted, etc.).
//
// Same section order and headings as the on-screen report
// (src/app/reports/report-view.tsx): verdict → narrative → where the money
// went → what to do about it → forward-looking notes. Keep the two in step.

const styles = StyleSheet.create({
  page: { padding: 44, fontSize: 11, fontFamily: "Helvetica", color: "#171717" },
  title: { fontSize: 20, marginBottom: 2, color: "#1E3A8A" },
  subtitle: { fontSize: 11, color: "#6B7280", marginBottom: 16 },
  verdict: { fontSize: 13, fontFamily: "Helvetica-Bold", marginBottom: 4 },
  totalsRow: { flexDirection: "row", gap: 28, marginBottom: 16 },
  totalLabel: { fontSize: 8, color: "#6B7280", marginBottom: 1 },
  totalValue: { fontSize: 13 },
  section: { marginTop: 16, borderTopWidth: 1, borderTopColor: "#E5E7EB", paddingTop: 10 },
  sectionTitle: { fontSize: 12, fontFamily: "Helvetica-Bold", marginBottom: 6, color: "#047857" },
  sectionTitleWarn: { color: "#B45309" },
  sectionTitleBad: { color: "#B91C1C" },
  narrative: { lineHeight: 1.5 },
  eyebrow: { fontSize: 8, color: "#6B7280", textTransform: "uppercase", letterSpacing: 0.5, marginTop: 6, marginBottom: 2 },
  row: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 3, borderBottomWidth: 1, borderBottomColor: "#E5E7EB" },
  rowLast: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 3 },
  rationale: { fontSize: 9, color: "#6B7280", marginTop: 1 },
  bullet: { paddingVertical: 2, lineHeight: 1.4 },
  amountBad: { color: "#B91C1C" },
  amountGood: { color: "#047857" },
});

function periodTitle(report: Report): string {
  if (report.type === "STARTUP") return "Startup Report";
  const [y, m] = report.periodKey.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString("en-US", { month: "long", year: "numeric" });
}

export async function renderReportPdf(report: Report): Promise<Buffer> {
  const findings = report.findings as unknown as ReportFindings;
  const isStartup = report.type === "STARTUP";

  const surplusCents = findings.totalIncomeCents - findings.totalSpentCents;
  const inSurplus = surplusCents >= 0;
  const ranShort = surplusCents < 0;

  const showCorrection = ranShort && !!findings.budgetCorrection;
  const showOpportunities = !!findings.postureSuggestion || !!findings.bigSurplusOpportunity;
  const showNotes =
    findings.newBucketSuggestions.length > 0 ||
    findings.budgetingIssues.length > 0 ||
    findings.detectedRecurring.length > 0;

  const doc = (
    <Document>
      <Page size="A4" style={styles.page}>
        <Text style={styles.title}>Flow — {periodTitle(report)}</Text>
        <Text style={styles.subtitle}>{isStartup ? "Initial setup analysis" : "Monthly budget report"}</Text>

        {!isStartup && (
          <Text style={[styles.verdict, inSurplus ? styles.amountGood : styles.amountBad]}>
            {inSurplus ? "Broke even" : "Short this month"}: {inSurplus ? "+" : "-"}
            {formatCents(Math.abs(surplusCents))}
          </Text>
        )}

        <View style={styles.totalsRow}>
          <View>
            <Text style={styles.totalLabel}>Income</Text>
            <Text style={styles.totalValue}>{formatCents(findings.totalIncomeCents)}</Text>
          </View>
          <View>
            <Text style={styles.totalLabel}>Spent (incl. debt)</Text>
            <Text style={styles.totalValue}>
              {formatCents(findings.monthSnapshot?.totalSpentCents ?? findings.totalSpentCents)}
            </Text>
          </View>
          <View>
            <Text style={styles.totalLabel}>Budgeted</Text>
            <Text style={styles.totalValue}>
              {formatCents(findings.monthSnapshot?.totalCapCents ?? findings.totalCapCents)}
            </Text>
          </View>
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>The Month in Review</Text>
          <Text style={styles.narrative}>{report.narrative}</Text>
        </View>

        {(() => {
          // Prefer the frozen full bucket breakdown; older reports without a
          // snapshot fall back to just the buckets that ran over.
          const snapBuckets = findings.monthSnapshot?.buckets ?? [];
          if (snapBuckets.length > 0) {
            const ordered = [...snapBuckets].sort((a, b) => {
              const ao = a.spentCents <= a.capCents;
              const bo = b.spentCents <= b.capCents;
              if (ao !== bo) return ao ? 1 : -1;
              return b.spentCents - b.capCents - (a.spentCents - a.capCents);
            });
            return (
              <View style={styles.section}>
                <Text style={styles.sectionTitle}>Where the Money Went</Text>
                {ordered.map((b, i) => {
                  const over = b.spentCents - b.capCents;
                  return (
                    <View key={b.name} style={i === ordered.length - 1 ? styles.rowLast : styles.row}>
                      <Text>{b.name}</Text>
                      <Text style={over > 0 ? styles.amountBad : undefined}>
                        {formatCents(b.spentCents)} / {formatCents(b.capCents)}
                        {over > 0 ? `  (+${formatCents(over)})` : ""}
                      </Text>
                    </View>
                  );
                })}
              </View>
            );
          }
          if (findings.overspendingBuckets.length === 0) return null;
          return (
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Where the Money Went</Text>
              {findings.overspendingBuckets.map((b, i) => (
                <View key={b.name} style={i === findings.overspendingBuckets.length - 1 ? styles.rowLast : styles.row}>
                  <Text>{b.name} — over budget</Text>
                  <Text style={styles.amountBad}>+{formatCents(b.overspendCents)}</Text>
                </View>
              ))}
            </View>
          );
        })()}

        {(findings.monthSnapshot?.oneTimePurchases?.length ?? 0) > 0 && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>One-Time Purchases</Text>
            <Text style={[styles.rationale, { marginBottom: 4 }]}>
              Funded outside the monthly budget — not counted in the totals above.
            </Text>
            {findings.monthSnapshot!.oneTimePurchases!.map((p, i, all) => (
              <View key={p.name} style={i === all.length - 1 ? styles.rowLast : styles.row}>
                <Text>{p.name}</Text>
                <Text>{formatCents(p.spentCents)}</Text>
              </View>
            ))}
          </View>
        )}

        {(findings.monthSnapshot?.extraIncome?.receivedCents ?? 0) > 0 &&
          (() => {
            const x = findings.monthSnapshot!.extraIncome!;
            return (
              <View style={styles.section}>
                <Text style={styles.sectionTitle}>Extra Income</Text>
                <Text style={[styles.rationale, { marginBottom: 4 }]}>
                  One-off and P2P money — already counted in the income total above.
                </Text>
                <View style={styles.row}>
                  <Text>Received</Text>
                  <Text>{formatCents(x.receivedCents)}</Text>
                </View>
                <View style={styles.row}>
                  <Text>
                    Covered Overspending
                    {x.byBucket.length > 0
                      ? ` (${x.byBucket.map((b) => `${b.name} ${formatCents(b.amountCents)}`).join(", ")})`
                      : ""}
                  </Text>
                  <Text>{formatCents(x.appliedCents)}</Text>
                </View>
                <View style={styles.rowLast}>
                  <Text>Added To Surplus</Text>
                  <Text>{formatCents(x.unappliedCents)}</Text>
                </View>
              </View>
            );
          })()}

        {showCorrection && (
          <View style={styles.section}>
            <Text style={[styles.sectionTitle, styles.sectionTitleBad]}>Getting Back to Breakeven</Text>
            <Text style={[styles.rationale, styles.amountBad, { marginBottom: 4 }]}>
              {formatCents(findings.budgetCorrection!.deficitCents)} over — here&apos;s where to trim.
            </Text>
            {findings.budgetCorrection!.suggestedCuts.map((c) => (
              <View key={c.bucketName} style={styles.bullet}>
                <View style={styles.rowLast}>
                  <Text>{c.bucketName}</Text>
                  <Text style={styles.amountBad}>
                    New cap {formatCents(c.suggestedCapCents)} (-{formatCents(c.cutCents)})
                  </Text>
                </View>
                <Text style={styles.rationale}>{c.rationale}</Text>
              </View>
            ))}
          </View>
        )}

        {showOpportunities && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Making the Most of the Margin</Text>
            {findings.postureSuggestion && (
              <View style={styles.bullet}>
                <View style={styles.rowLast}>
                  <Text>
                    {findings.postureSuggestion.type === "DEBT_PAYDOWN" ? "Pay down" : "Save toward"}:{" "}
                    {findings.postureSuggestion.targetName}
                  </Text>
                  <Text style={styles.amountGood}>
                    +{formatCents(findings.postureSuggestion.suggestedAmountCents)}/mo
                  </Text>
                </View>
                <Text style={styles.rationale}>{findings.postureSuggestion.rationale}</Text>
              </View>
            )}
            {findings.bigSurplusOpportunity && (
              <View style={styles.bullet}>
                <Text>Big surplus: {formatCents(findings.bigSurplusOpportunity.surplusCents)}</Text>
                <Text style={styles.rationale}>{findings.bigSurplusOpportunity.note}</Text>
              </View>
            )}
          </View>
        )}

        {findings.postureRealignment && (
          <View style={styles.section}>
            <Text style={[styles.sectionTitle, styles.sectionTitleWarn]}>Revisit Your Primary Goal</Text>
            <Text style={styles.bullet}>
              Your Primary Goal is{" "}
              {GOAL_POSTURE_LABEL[findings.postureRealignment.currentPosture] ??
                findings.postureRealignment.currentPosture}
              , but your finances point toward{" "}
              {GOAL_POSTURE_LABEL[findings.postureRealignment.suggestedPosture] ??
                findings.postureRealignment.suggestedPosture}
              .
            </Text>
            <Text style={styles.rationale}>{findings.postureRealignment.rationale}</Text>
          </View>
        )}

        {findings.savingsGoalInsights.length > 0 && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Savings Goals</Text>
            {findings.savingsGoalInsights.map((g) => (
              <View key={g.name} style={styles.bullet}>
                <View style={styles.rowLast}>
                  <Text>{g.name}</Text>
                  <Text style={g.onTrack ? styles.amountGood : styles.sectionTitleWarn}>
                    {g.onTrack ? "On track" : "Behind"}
                  </Text>
                </View>
                <Text style={styles.rationale}>{g.note}</Text>
              </View>
            ))}
          </View>
        )}

        {showNotes && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Also Worth Noting</Text>

            {findings.budgetingIssues.map((issue, i) => (
              <Text key={i} style={styles.bullet}>
                • {issue}
              </Text>
            ))}

            {findings.newBucketSuggestions.length > 0 && (
              <>
                <Text style={styles.eyebrow}>{isStartup ? "Suggested buckets" : "New bucket ideas"}</Text>
                {findings.newBucketSuggestions.map((b) => (
                  <View key={b.name} style={styles.bullet}>
                    <View style={styles.rowLast}>
                      <Text>{b.name}</Text>
                      <Text>{formatCents(b.monthlyCapCents)}/mo</Text>
                    </View>
                    <Text style={styles.rationale}>{b.rationale}</Text>
                  </View>
                ))}
              </>
            )}

            {findings.detectedRecurring.length > 0 && (
              <>
                <Text style={styles.eyebrow}>Possible untracked bills</Text>
                {findings.detectedRecurring.map((r, i) => (
                  <View
                    key={r.merchant}
                    style={i === findings.detectedRecurring.length - 1 ? styles.rowLast : styles.row}
                  >
                    <Text>
                      {r.merchant} ({r.cadence.toLowerCase()})
                    </Text>
                    <Text>{formatCents(r.amountCents)}</Text>
                  </View>
                ))}
              </>
            )}
          </View>
        )}
      </Page>
    </Document>
  );

  return renderToBuffer(doc);
}

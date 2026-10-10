import { redirect } from "next/navigation";
import { requireOwner } from "@/lib/access";
import Image from "next/image";
import { db } from "@/lib/db";
import { getOrCreateStartupReport } from "@/lib/reports";
import { GeometricBackground } from "@/components/geometric-background";
import { OnboardingWizard } from "./onboarding-wizard";
import type { ReportFindings } from "@/lib/ai";

export default async function OnboardingPage() {
  const session = await requireOwner();

  const household = await db.household.findUniqueOrThrow({ where: { id: session.user.householdId } });
  if (household.onboardingCompletedAt) redirect("/");

  const [bankConnection, aiSettings, bucketCount, emailConnection] = await Promise.all([
    db.bankConnection.findUnique({ where: { householdId: household.id } }),
    db.householdAiSettings.findUnique({
      where: { householdId: household.id },
      select: { provider: true, status: true, lastError: true },
    }),
    db.bucket.count({ where: { householdId: household.id } }),
    // A member can connect more than one inbox (household request,
    // 2026-09-11), but onboarding only ever shows/creates the first —
    // oldest-first so a fresh setup is deterministic.
    db.emailConnection.findFirst({
      where: { userId: session.user.id },
      orderBy: { createdAt: "asc" },
      select: { imapUser: true, status: true },
    }),
  ]);

  // Only worth attempting once the household has actually connected
  // something — getOrCreateStartupReport itself no-ops (returns null)
  // if there's no AI configured or no synced transaction history yet, but
  // gating on the step avoids the query entirely during earlier phases.
  let startupReport: { narrative: string; findings: ReportFindings } | null = null;
  if (household.onboardingStep === "REPORT" || household.onboardingStep === "BUCKETS") {
    const report = await getOrCreateStartupReport(household.id);
    startupReport = report ? { narrative: report.narrative, findings: report.findings as unknown as ReportFindings } : null;
  }

  return (
    <main className="relative mx-auto flex min-h-dvh max-w-lg flex-col justify-center gap-6 overflow-hidden px-4 py-10">
      <GeometricBackground />
      <div className="relative flex flex-col gap-6">
        <div>
          <Image src="/icons/flow-mark.png" alt="" width={90} height={67} className="mb-3 h-14 w-auto" priority />
          <h1 className="text-2xl font-bold text-blue-900 dark:text-blue-300">Let&apos;s set up your budget</h1>
          <p className="mt-1 text-sm text-gray-500 dark:text-neutral-400">
            A few quick steps, then flow builds a starting budget from your real spending.
          </p>
        </div>

        <OnboardingWizard
          step={household.onboardingStep}
          profile={{
            goalPosture: household.goalPosture,
            adultsCount: household.adultsCount,
            kidsCount: household.kidsCount,
            incomeCalcMethod: household.incomeCalcMethod,
            includeP2PInIncomeCalc: household.includeP2PInIncomeCalc,
          }}
          bankConnected={!!bankConnection}
          bankSyncError={bankConnection?.lastError ?? null}
          aiExisting={aiSettings}
          emailConnection={emailConnection}
          bucketCount={bucketCount}
          startupReport={startupReport}
        />
      </div>
    </main>
  );
}

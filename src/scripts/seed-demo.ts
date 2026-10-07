/**
 * seed-demo.ts — builds (and finalizes) the read-only "example household"
 * reachable from /login.
 *
 * Run via the standard throwaway-node-container flow:
 *   docker run --rm --network host --env-file .env -v "$(pwd)":/app -w /app \
 *     -e DEMO_PASSWORD=... node:22-alpine npx tsx src/scripts/seed-demo.ts [flags]
 *
 * Flags:
 *   (none)        Full seed: household + user + AI (copied from the real
 *                 household) + SimpleFIN demo connection + sync + wizard
 *                 profile fields + curated debts/assets/goals. Leaves
 *                 onboardingStep=PROFILE so the wizard UI can be walked.
 *   --force       Delete an existing demo household first (cascade).
 *   --buckets     After a wizard/HTTP pass has created the STARTUP report,
 *                 create Bucket rows from its suggestions, categorize, set
 *                 onboardingCompletedAt. (Mirrors confirmBucketsAndFinish.)
 *   --finalize    Clear the AI key, wipe the demo user's password/TOTP,
 *                 flip Household.isDemo=true, mark the bank connection healthy.
 *                 Run this LAST, after the audit pass.
 *   --auto        Non-interactive full pipeline in one process: fullSeed (as
 *                 if --force were passed) -> bucketsStep -> finalize, with no
 *                 wizard walkthrough in between. bucketsStep finds no STARTUP
 *                 report in this path, so it always uses its hardcoded
 *                 fallback bucket set rather than an AI suggestion. This is
 *                 what the monthly cron refresh runs (see WORKING_ON.md's
 *                 demo-household section) so the example household never
 *                 drifts more than a month stale.
 *
 * DEMO_AI_KEY / DEMO_AI_PROVIDER are NOT needed — the script copies the real
 * household's encrypted HouseholdAiSettings row verbatim (same ENCRYPTION_KEY).
 */
import { db } from "@/lib/db";
import { encrypt } from "@/lib/crypto";
import { hashPassword } from "@/lib/password";
import { generateSecret } from "otplib";
import { randomBytes } from "node:crypto";
import { DEFAULT_BILL_CATEGORY_NAMES } from "@/lib/bill-category";
import { syncHousehold, categorizeUncategorizedTransactions } from "@/lib/simplefin-sync";
import { ensureBucketIcons } from "@/lib/bucket-icons-sync";
import { getNetWorth } from "@/lib/networth";
import { detectRecurringIncome } from "@/lib/income-detect";

const DEMO_EMAIL = "demo@example.invalid";
const DEMO_NAME = "Alex Rivera";
const DEMO_HOUSEHOLD_NAME = "The Rivera Household (Example)";
// SimpleFIN's public demo bridge — synthetic checking + savings, ~90d of tx.
const SIMPLEFIN_DEMO_ACCESS_URL = "https://demo:demo@beta-bridge.simplefin.org/simplefin";

const flags = new Set(process.argv.slice(2));

function log(...a: unknown[]) {
  console.log("[seed-demo]", ...a);
}

async function findDemo() {
  return db.household.findFirst({
    where: { OR: [{ name: DEMO_HOUSEHOLD_NAME }, { users: { some: { email: DEMO_EMAIL } } }] },
    include: { users: true, bankConnection: true, aiSettings: true },
  });
}

async function copyAiSettings(householdId: string) {
  const real = await db.householdAiSettings.findFirst({
    where: { household: { users: { none: { email: DEMO_EMAIL } } } },
  });
  if (!real) throw new Error("No real HouseholdAiSettings row to copy from.");
  await db.householdAiSettings.upsert({
    where: { householdId },
    create: {
      householdId,
      provider: real.provider,
      apiKeyEncrypted: real.apiKeyEncrypted, // same ENCRYPTION_KEY -> decrypts fine
      status: "ACTIVE",
    },
    update: { provider: real.provider, apiKeyEncrypted: real.apiKeyEncrypted, status: "ACTIVE", lastError: null },
  });
  log(`copied AI settings (${real.provider})`);
}

async function seedCuratedExtras(householdId: string) {
  // A representative set of manual debts/assets/goals — the SimpleFIN demo
  // server only exposes depository accounts, so none of this comes from sync.
  const catByName = new Map(
    (await db.billCategory.findMany({ where: { householdId } })).map((c) => [c.name, c.id]),
  );
  const loanPaymentCat = catByName.get("Loan payment") ?? null;

  // --- Mortgage (REVOLVING/LOAN, manual) + linked HOME_EQUITY asset ---
  const mortgage = await db.debt.create({
    data: {
      householdId,
      name: "Home Mortgage",
      debtType: "REVOLVING",
      kind: "LOAN",
      source: "MANUAL",
      balanceCents: 285_000_00,
      aprBasisPoints: 615,
      minPaymentCents: 2_190_00,
      termsConfirmed: true,
      includeInPayoffPlan: false,
      sortOrder: 0,
    },
  });
  await db.debtPayment.create({
    data: {
      householdId,
      debtId: mortgage.id,
      amountCents: 2_190_00,
      amountDueCents: 2_190_00,
      cadence: "MONTHLY",
      categoryId: loanPaymentCat,
      nextDueDate: firstOfNextMonth(),
      dueDateLocked: true,
      active: true,
    },
  });
  await db.asset.create({
    data: {
      householdId,
      name: "Primary Residence",
      assetType: "HOME_EQUITY",
      valueCents: 412_000_00,
      asOfDate: today(),
      source: "MANUAL",
      debtId: mortgage.id,
    },
  });

  // --- Auto loan (REVOLVING/LOAN) + VEHICLE_EQUITY asset ---
  const auto = await db.debt.create({
    data: {
      householdId,
      name: "Auto Loan — Honda CR-V",
      debtType: "REVOLVING",
      kind: "LOAN",
      source: "MANUAL",
      balanceCents: 18_400_00,
      aprBasisPoints: 549,
      minPaymentCents: 465_00,
      termsConfirmed: true,
      sortOrder: 1,
    },
  });
  await db.debtPayment.create({
    data: {
      householdId,
      debtId: auto.id,
      amountCents: 465_00,
      amountDueCents: 465_00,
      cadence: "MONTHLY",
      categoryId: loanPaymentCat,
      nextDueDate: firstOfNextMonth(),
      dueDateLocked: true,
      active: true,
    },
  });
  await db.asset.create({
    data: {
      householdId,
      name: "2022 Honda CR-V",
      assetType: "VEHICLE_EQUITY",
      valueCents: 24_900_00,
      asOfDate: today(),
      source: "MANUAL",
      debtId: auto.id,
    },
  });

  // --- Credit card (REVOLVING/CARD) with a real minimum ---
  const card = await db.debt.create({
    data: {
      householdId,
      name: "Sapphire Rewards Card",
      debtType: "REVOLVING",
      kind: "CARD",
      source: "MANUAL",
      balanceCents: 3_240_00,
      aprBasisPoints: 2199,
      minPaymentCents: 85_00,
      termsConfirmed: true,
      sortOrder: 2,
    },
  });
  await db.debtPayment.create({
    data: {
      householdId,
      debtId: card.id,
      amountCents: 85_00,
      amountDueCents: 85_00,
      cadence: "MONTHLY",
      categoryId: catByName.get("Loan payment") ?? null,
      nextDueDate: firstOfNextMonth(),
      dueDateLocked: true,
      active: true,
    },
  });

  // --- BNPL (INSTALLMENT) ---
  const bnpl = await db.debt.create({
    data: {
      householdId,
      name: "Affirm — Peloton",
      debtType: "INSTALLMENT",
      kind: "BNPL",
      source: "MANUAL",
      balanceCents: 149_00 * 6,
      aprBasisPoints: 0,
      minPaymentCents: 149_00,
      termsConfirmed: true,
      installmentsTotal: 12,
      installmentsRemaining: 6,
      purchaseDate: monthsAgo(6),
      label: "Peloton Bike+",
      sortOrder: 3,
    },
  });
  await db.debtPayment.create({
    data: {
      householdId,
      debtId: bnpl.id,
      amountCents: 149_00,
      amountDueCents: 149_00,
      cadence: "MONTHLY",
      nextDueDate: firstOfNextMonth(),
      dueDateLocked: true,
      active: true,
    },
  });

  // --- Non-secured assets ---
  await db.asset.create({
    data: {
      householdId,
      name: "401(k) — Fidelity",
      assetType: "RETIREMENT_401K",
      valueCents: 96_500_00,
      asOfDate: today(),
      source: "MANUAL",
    },
  });
  await db.asset.create({
    data: {
      householdId,
      name: "Brokerage — Index Funds",
      assetType: "INVESTMENT",
      valueCents: 41_200_00,
      asOfDate: today(),
      source: "MANUAL",
    },
  });

  // --- Savings goals (one plain, one sinking fund with a monthly target) ---
  await db.savingsGoal.create({
    data: {
      householdId,
      name: "Emergency Fund",
      description: "Three months of essential expenses in a high-yield savings account.",
      targetAmountCents: 18_000_00,
      currentAmountCents: 11_250_00,
      source: "MANUAL",
      reminderEnabled: false,
    },
  });
  await db.savingsGoal.create({
    data: {
      householdId,
      name: "Family Trip — Summer",
      description: "A week away with the kids next summer.",
      targetAmountCents: 6_000_00,
      currentAmountCents: 1_400_00,
      targetDate: monthsFromNow(9),
      monthlyTargetCents: 500_00,
      source: "MANUAL",
      reminderEnabled: false,
    },
  });

  // --- Track the demo bridge's real payroll deposits (payee "You", "Pay
  //     day!", 1st & 15th) the way a household accepting the /income
  //     suggestion would — same fields as acceptIncomeSuggestion. A
  //     hand-written Income (it used to be a biweekly row on checking with no
  //     merchant) matched none of them: the paycheck showed overdue, the
  //     deposits kept being suggested as a new income called "You", and
  //     each one counted as Extra Income. Without any Income row the whole
  //     app treats monthly income as $0, hence the manual fallback. ---
  const checking = await db.account.findFirst({
    where: { householdId, accountType: "CHECKING" },
  });
  const paycheck = (await detectRecurringIncome(householdId)).sort((a, b) => b.amountCents - a.amountCents)[0];
  if (paycheck) {
    const latest = await db.transaction.findFirst({
      where: { id: { in: paycheck.transactionIds } },
      orderBy: { occurredOn: "desc" },
      select: { occurredOn: true },
    });
    const income = await db.income.create({
      data: {
        householdId,
        name: "Primary Paycheck",
        merchant: paycheck.merchant,
        amountCents: paycheck.amountCents,
        cadence: paycheck.cadence,
        semiMonthlyDays: paycheck.semiMonthlyDays,
        nextPayDate: paycheck.nextPayDate,
        lastReceivedDate: latest?.occurredOn,
        source: "SIMPLEFIN",
        accountId: paycheck.accountId,
      },
    });
    await db.transaction.updateMany({
      where: { id: { in: paycheck.transactionIds } },
      data: { incomeId: income.id },
    });
    await db.suggestionDismissal.create({ data: { householdId, kind: "INCOME", key: paycheck.key } });
  } else {
    await db.income.create({
      data: {
        householdId,
        name: "Primary Paycheck",
        amountCents: 2_564_48,
        cadence: "BIWEEKLY",
        nextPayDate: nextFriday(),
        lastReceivedDate: daysAgo(3),
        source: checking ? "SIMPLEFIN" : "MANUAL",
        accountId: checking?.id ?? null,
      },
    });
  }

  // --- Give every debt tracker a settled prior cycle so a freshly-seeded
  //     debt doesn't render as "overdue" (no synced payment history exists
  //     for a manual debt, and buildCycleSlots otherwise reconstructs the
  //     prior cycle as unpaid). One paid transfer transaction per tracker. ---
  const trackers = await db.debtPayment.findMany({
    where: { householdId, active: true },
    include: { debt: true },
  });
  for (const t of trackers) {
    const paidOn = new Date(t.nextDueDate);
    paidOn.setUTCMonth(paidOn.getUTCMonth() - 1);
    paidOn.setUTCDate(2);
    await db.transaction.create({
      data: {
        householdId,
        accountId: checking?.id ?? undefined,
        simpleFinTransactionId: `demo-debtpay-${t.id}`,
        merchant: t.debt.name,
        rawDescription: `Payment — ${t.debt.name}`,
        amountCents: t.amountCents,
        occurredOn: paidOn,
        isTransfer: true,
        debtId: t.debtId,
        debtPaymentId: t.id,
        categoryId: t.categoryId ?? undefined,
      },
    });
    await db.debtPayment.update({ where: { id: t.id }, data: { lastPaidDate: paidOn } });
  }

  log("curated: 4 debts (+trackers +prior-cycle payments), 4 assets, 2 goals, 1 income");
}

function daysAgo(n: number) {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - n));
}
function nextFriday() {
  const d = new Date();
  const day = d.getUTCDay();
  const add = ((5 - day + 7) % 7) || 7;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + add));
}

function today() {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}
function firstOfNextMonth() {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
}
function monthsAgo(n: number) {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - n, d.getUTCDate()));
}
function monthsFromNow(n: number) {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, d.getUTCDate()));
}

async function fullSeed() {
  const existing = await findDemo();
  if (existing) {
    if (!flags.has("--force") && !flags.has("--auto")) {
      log(`demo household already exists (${existing.id}). Use --force to recreate.`);
      return;
    }
    await db.household.delete({ where: { id: existing.id } });
    log(`deleted existing demo household ${existing.id}`);
  }

  const demoPassword = process.env.DEMO_PASSWORD || randomBytes(18).toString("base64url");
  const passwordHash = await hashPassword(demoPassword);
  const totpSecret = generateSecret();

  const household = await db.household.create({
    data: {
      name: DEMO_HOUSEHOLD_NAME,
      goalPosture: "BALANCED",
      adultsCount: 2,
      kidsCount: 2,
      // The demo paycheck is semi-monthly (1st & 15th), so the biweekly
      // "no 3rd check" method would only mislabel the /income total.
      incomeCalcMethod: "MONTHLY_AVERAGE",
      // Show the payoff plan applied (dashboard extras, bucket budgets),
      // not /debts' "Projection Only" preview.
      payoffPlanEnabled: true,
      onboardingStep: "PROFILE",
      onboardingCompletedAt: null,
    },
  });
  await db.billCategory.createMany({
    data: DEFAULT_BILL_CATEGORY_NAMES.map((name) => ({ householdId: household.id, name })),
  });
  const user = await db.user.create({
    data: {
      householdId: household.id,
      name: DEMO_NAME,
      email: DEMO_EMAIL,
      passwordHash,
      role: "OWNER",
      dashboardScope: "FULL",
      totpSecretEncrypted: encrypt(totpSecret),
      totpEnabled: true,
      totpVerifiedAt: new Date(),
    },
  });
  log(`household ${household.id} / user ${user.id}`);
  log(`DEMO_PASSWORD=${demoPassword}`);
  log(`DEMO_TOTP_SECRET=${totpSecret}`);

  await copyAiSettings(household.id);

  await db.bankConnection.create({
    data: {
      householdId: household.id,
      accessUrlEncrypted: encrypt(SIMPLEFIN_DEMO_ACCESS_URL),
      status: "ACTIVE",
    },
  });
  log("bank connection created — syncing…");
  const res = await syncHousehold(household.id);
  log(`sync: ${JSON.stringify(res)}`);

  await seedCuratedExtras(household.id);

  log("full seed done. Next: walk the wizard UI as the demo user, then run");
  log("  --buckets (if the wizard didn't create them), then --finalize.");
}

async function bucketsStep() {
  const demo = await findDemo();
  if (!demo) throw new Error("no demo household");
  const householdId = demo.id;

  const existingBuckets = await db.bucket.count({ where: { householdId } });
  if (existingBuckets > 0) {
    log(`${existingBuckets} buckets already exist — skipping creation.`);
  } else {
    const startup = await db.report.findUnique({
      where: { householdId_periodKey: { householdId, periodKey: "STARTUP" } },
    });
    type Suggestion = { name?: string; monthlyCapCents?: number; trackingMode?: string };
    const findings = (startup?.findings as { newBucketSuggestions?: Suggestion[] } | null) ?? null;
    const suggestions = findings?.newBucketSuggestions ?? [];
    const drafts = suggestions.length
      ? suggestions
      : [
          { name: "Groceries", monthlyCapCents: 90_000, trackingMode: "SPEND" },
          { name: "Dining Out", monthlyCapCents: 30_000, trackingMode: "SPEND" },
          { name: "Bills & Utilities", monthlyCapCents: 120_000, trackingMode: "RECURRING" },
          { name: "Transportation", monthlyCapCents: 45_000, trackingMode: "SPEND" },
          { name: "Kids", monthlyCapCents: 40_000, trackingMode: "MIXED" },
          { name: "Everything Else", monthlyCapCents: 50_000, trackingMode: "SPEND" },
        ];
    await db.bucket.createMany({
      data: drafts.map((b, i) => ({
        householdId,
        name: String(b.name ?? `Bucket ${i + 1}`),
        monthlyCapCents: Number(b.monthlyCapCents ?? 50_000),
        trackingMode: (["SPEND", "RECURRING", "MIXED"].includes(String(b.trackingMode))
          ? b.trackingMode
          : "SPEND") as "SPEND" | "RECURRING" | "MIXED",
        sortOrder: i,
      })),
    });
    log(`created ${drafts.length} buckets (${suggestions.length ? "from STARTUP report" : "fallback set"})`);
  }

  log("categorizing…");
  await categorizeUncategorizedTransactions(householdId);
  await ensureBucketIcons(householdId);
  await db.household.update({
    where: { id: householdId },
    data: { onboardingCompletedAt: new Date(), onboardingStep: "DONE" },
  });
  log("onboarding marked complete.");
}

async function backdateSnapshots(householdId: string) {
  // A real new household's trend charts legitimately start empty (baseline =
  // first page visit). For the *demo* that reads as unfinished, so give it a
  // few weeks of gently-varying history to render a real line. Idempotent-ish:
  // upsert per dateKey.
  //
  // Computed directly rather than read back from an existing snapshot row:
  // the --auto path (monthly cron refresh) never has a human visit
  // /networth or /debts to lazily create one first (that write is also
  // isDemoHousehold-guarded once isDemo flips true, which hasn't happened
  // yet here, but there's still no request to trigger it).
  const { netWorthCents: nwNow } = await getNetWorth(householdId);
  const debtAgg = await db.debt.aggregate({ where: { householdId, hiddenAt: null }, _sum: { balanceCents: true } });
  const dsNow = debtAgg._sum.balanceCents ?? 0;
  const todayKey = today().toISOString().slice(0, 10);
  await db.netWorthSnapshot.upsert({
    where: { householdId_dateKey: { householdId, dateKey: todayKey } },
    create: { householdId, dateKey: todayKey, netWorthCents: nwNow },
    update: { netWorthCents: nwNow },
  });
  await db.debtSnapshot.upsert({
    where: { householdId_dateKey: { householdId, dateKey: todayKey } },
    create: { householdId, dateKey: todayKey, totalDebtCents: dsNow },
    update: { totalDebtCents: dsNow },
  });
  for (let weeksAgo = 12; weeksAgo >= 1; weeksAgo--) {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - weeksAgo * 7);
    const dateKey = d.toISOString().slice(0, 10);
    // net worth drifting up ~$1.4k/wk, debt drifting down ~$0.6k/wk
    const nw = nwNow - weeksAgo * 140_00 * 10;
    const debt = dsNow + weeksAgo * 60_00 * 10;
    await db.netWorthSnapshot.upsert({
      where: { householdId_dateKey: { householdId, dateKey } },
      create: { householdId, dateKey, netWorthCents: nw },
      update: { netWorthCents: nw },
    });
    await db.debtSnapshot.upsert({
      where: { householdId_dateKey: { householdId, dateKey } },
      create: { householdId, dateKey, totalDebtCents: debt },
      update: { totalDebtCents: debt },
    });
  }
  log("back-dated 12 weeks of net-worth + debt snapshots");
}

async function finalize() {
  const demo = await findDemo();
  if (!demo) throw new Error("no demo household");
  const householdId = demo.id;

  await backdateSnapshots(householdId);
  await db.householdAiSettings.deleteMany({ where: { householdId } });
  const lockPassword = randomBytes(24).toString("base64url");
  await db.user.updateMany({
    where: { householdId },
    data: {
      passwordHash: await hashPassword(lockPassword),
      totpEnabled: false,
      totpSecretEncrypted: null,
      totpVerifiedAt: null,
    },
  });
  await db.household.update({
    where: { id: householdId },
    data: { isDemo: true, onboardingCompletedAt: new Date(), onboardingStep: "DONE" },
  });
  await db.bankConnection.updateMany({
    where: { householdId },
    data: { status: "ACTIVE", lastError: null, lastSyncedAt: new Date() },
  });
  log("finalized: AI key cleared, password/TOTP locked, isDemo=true, bank healthy.");
}

async function main() {
  if (flags.has("--finalize")) return finalize();
  if (flags.has("--buckets")) return bucketsStep();
  await fullSeed();
  if (flags.has("--auto")) {
    await bucketsStep();
    await finalize();
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });

import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { hasFullAccess } from "@/lib/access";
import { AppShell } from "@/components/app-shell";
import { isHouseholdScanning } from "@/lib/receipt-sync";
import { EmailSettingsPanel } from "./email-settings-panel";
import { EmailUsageSynopsis } from "./email-usage-synopsis";
import {
  receiptChargeScopeWhere,
  receiptAmountWhere,
  receiptSignMatches,
  receiptMatchWindow,
  plausibleReceiptCharge,
  aliasKey,
  RECEIPT_WIDE_MATCH_AFTER_DAYS,
} from "@/lib/receipt-match";
import { getCuratedDomain } from "@/lib/merchant-domains";
import {
  bnplPlanOriginalPrincipalCents,
  bnplPlanTotalMatches,
  bnplPlanDateInWindow,
} from "@/lib/bnpl-plan-match";
import {
  ReceiptLinker,
  type ReceiptToLink,
  type LinkCandidateTransaction,
  type LinkCandidatePlan,
} from "@/components/receipt-linker";
import { BillNoticeLinker, type LinkCandidate } from "@/components/bill-notice-linker";
import { getUnmatchedBillNotices } from "@/lib/bill-notice-sync";
import { debtDisplayName } from "@/lib/debt-payments";

const ISO_DAY = (d: Date) => d.toISOString().slice(0, 10);

// A receipt whose stated total split across two separate bank transactions
// (a bill posting its own online-payment fee as its own charge, a
// multi-shipment order) never has a single same-amount candidate — search
// the same date-windowed pool (this time with no amount filter) for any two
// whose amounts sum to the total. Two-way only, no 3+-way search: covers
// every real case seen so far (see linkReceiptToTransactions,
// src/app/transactions/actions.ts) without the combinatorics of a general
// subset-sum picker, and the pool is small enough (one household's
// transactions in a several-day window) that this is trivially O(n^2).
//
// Three gates on each candidate pair:
//   1. Both legs post on the *same day* — a real split payment (goods + its
//      own fee, two shipments billed together) lands as one same-day pair;
//      two charges days apart that merely sum to the total are coincidence.
//   2. At least one leg actually looks like the receipt's merchant (name
//      resemblance or a learned alias — plausibleReceiptCharge). The other
//      is free to be a fee / service charge / second-shipment fulfiller —
//      but not just *any* charge (see gate 3).
//   3. Whichever leg doesn't match the receipt's own merchant must not
//      itself be a separately recognizable, well-known merchant (checked
//      via the same curated brand table MerchantLogo/resolveMerchantLogoDomain
//      use — zero-cost regex lookup, no network). A real service charge on
//      top of a bill/payment (an online-payment convenience fee, a second
//      shipment's own handling charge) never has its own identity as a
//      named business; two DIFFERENT recognizable brands summing to a
//      number is coincidence, not a split (household report, 2026-09-22: a
//      $40.51 QuikStop receipt paired a genuine $1.51 QuikStop charge with an
//      unrelated $39.00 Panda Express charge that happened to complete the
//      total).
// Without gates 1-2, any two unrelated debits summing to the total surfaced
// as a "split" (real report, 2026-09-07: a $12.42 Frosty's receipt paired
// with a $9.24 + $3.18 pair of Walmart charges six days apart).
function findComboCandidates<T extends { amountCents: number; occurredOn: Date; merchant: string }>(
  pool: T[],
  totalCents: number,
  hasMerchantLeg: (t: T) => boolean,
): [T, T][] {
  const merchantLeg = new Map<T, boolean>();
  const isMerchantLeg = (t: T) => {
    let v = merchantLeg.get(t);
    if (v === undefined) {
      v = hasMerchantLeg(t);
      merchantLeg.set(t, v);
    }
    return v;
  };
  const isWellKnownMerchant = (t: T) => getCuratedDomain(t.merchant) !== null;
  const combos: [T, T][] = [];
  for (let i = 0; i < pool.length; i++) {
    for (let j = i + 1; j < pool.length; j++) {
      if (Math.abs(pool[i].amountCents) + Math.abs(pool[j].amountCents) !== totalCents) continue;
      if (ISO_DAY(pool[i].occurredOn) !== ISO_DAY(pool[j].occurredOn)) continue;
      const iMatches = isMerchantLeg(pool[i]);
      const jMatches = isMerchantLeg(pool[j]);
      if (!iMatches && !jMatches) continue;
      if (!iMatches && isWellKnownMerchant(pool[i])) continue;
      if (!jMatches && isWellKnownMerchant(pool[j])) continue;
      combos.push([pool[i], pool[j]]);
    }
  }
  return combos.slice(0, 3);
}

function summarizeItems(lineItems: unknown): string | null {
  if (!Array.isArray(lineItems) || lineItems.length === 0) return null;
  const names = lineItems
    .map((li) => (li && typeof li === "object" ? String((li as { description?: unknown }).description ?? "") : ""))
    .map((s) => s.trim())
    .filter(Boolean);
  if (names.length === 0) return null;
  const shown = names.slice(0, 2).join(", ");
  return names.length > 2 ? `${shown}…` : shown;
}

export default async function EmailSettingsPage() {
  const session = await auth();
  if (!session?.user) redirect("/login");
  if (!hasFullAccess(session.user)) redirect("/");

  const userId = session.user.id;
  const householdId = session.user.householdId;

  // A member can have more than one connected inbox (household request,
  // 2026-09-11) — everything below that used to key off "the" single
  // connection now aggregates across all of this member's rows instead.
  const connections = await db.emailConnection.findMany({
    where: { userId },
    orderBy: { createdAt: "asc" },
    select: { id: true, imapUser: true, status: true, lastError: true, lastPolledAt: true },
  });
  const hasConnection = connections.length > 0;
  const lastPolledAt = connections.reduce<Date | null>(
    (latest, c) => (c.lastPolledAt && (!latest || c.lastPolledAt > latest) ? c.lastPolledAt : latest),
    null,
  );

  const [parsedCount, unmatchedAll, latestTxn] = hasConnection
    ? await Promise.all([
        db.receipt.count({
          where: { emailConnection: { userId }, matchState: { notIn: ["STALE", "DISMISSED"] } },
        }),
        db.receipt.findMany({
          where: {
            emailConnection: { userId },
            matchState: { in: ["UNMATCHED", "AMBIGUOUS"] },
            totalCents: { not: null },
          },
          orderBy: { receivedAt: "desc" },
          take: 25,
          select: {
            id: true,
            party: true,
            partyIsPerson: true,
            p2pApp: true,
            totalCents: true,
            occurredOn: true,
            receivedAt: true,
            kind: true,
            noteText: true,
            isRefund: true,
            refundTo: true,
            refundToLast4: true,
            lineItems: true,
          },
        }),
        db.transaction.aggregate({ where: { householdId }, _max: { occurredOn: true } }),
      ])
    : [0, [], { _max: { occurredOn: null } }];

  // Item 1 (2026-08-29): a receipt email arrives the moment you pay; the bank
  // charge shows up in SimpleFIN a day or two later. Until the bank data has
  // caught up to a receipt's date there's simply nothing for it to match, so
  // don't nag about it — matchReceipts keeps retrying it silently every sync.
  const bankCaughtUpTo = latestTxn._max.occurredOn;
  const unmatched = bankCaughtUpTo
    ? unmatchedAll.filter((r) => (r.occurredOn ?? r.receivedAt) <= bankCaughtUpTo)
    : unmatchedAll;

  // BNPL installment plans a receipt with no bank charge could belong to
  // instead — see bnpl-plan-match.ts / matchReceiptToBnplPlan. Fetched once;
  // filtered per receipt below (total + purchase-date window; merchant-name
  // resemblance isn't required here the way it is for the auto-linker, since
  // a human confirms the pick — that's what lets "Safelite $200" reach the
  // "$200 Afterpay - CR-V" / "- F-150" plans the auto-linker can't name).
  const installmentPlans = hasConnection
    ? await db.debt.findMany({
        // Paid-off / hidden plans included on purpose — a windshield-repair
        // receipt belongs on its "Afterpay - CR-V" plan even after it's paid
        // and tucked away; the auto-linker stays stricter (visible plans
        // only, matchReceiptToBnplPlan).
        where: { householdId, debtType: "INSTALLMENT", receipts: { none: {} } },
        select: {
          id: true,
          name: true,
          label: true,
          balanceCents: true,
          minPaymentCents: true,
          installmentsTotal: true,
          purchaseDate: true,
          debtPayment: { select: { amountDueCents: true } },
        },
      })
    : [];

  // Bank-merchant strings the household has manually linked a receipt party
  // to before (Classifieds.com → "Mountain Digital Media") — same learned aliases the
  // auto-linker treats as name-plausible (receipt-sync.ts). Batched here for
  // every party in view; consulted by the split-total combo gate below.
  const aliasParties = [
    ...new Set(unmatched.map((r) => r.party).filter((p): p is string => !!p).map(aliasKey)),
  ];
  const aliasByParty = new Map<string, Set<string>>();
  if (aliasParties.length > 0) {
    for (const a of await db.receiptMerchantAlias.findMany({
      where: { householdId, receiptParty: { in: aliasParties } },
      select: { receiptParty: true, merchantText: true },
    })) {
      const set = aliasByParty.get(a.receiptParty) ?? new Set<string>();
      set.add(a.merchantText);
      aliasByParty.set(a.receiptParty, set);
    }
  }

  // Candidate charges for each still-unmatched receipt: an unlinked
  // household transaction at the same amount within a few days.
  const linkRows: {
    receipt: ReceiptToLink;
    candidates: LinkCandidateTransaction[];
    comboCandidates: LinkCandidateTransaction[][];
    planCandidates: LinkCandidatePlan[];
  }[] = [];
  for (const r of unmatched) {
    const anchor = r.occurredOn ?? r.receivedAt;
    // A receipt's bank charge posts on or after the receipt date (see
    // receiptMatchWindow). The picker reaches further out than the tight
    // auto-match window — a check or scheduled bill-pay clears days late,
    // and a human can judge a further-out candidate the auto-matcher won't
    // touch — but still not into the weeks *before* the receipt.
    const { from, to } = receiptMatchWindow(anchor, RECEIPT_WIDE_MATCH_AFTER_DAYS);
    const cands = (
      await db.transaction.findMany({
        where: {
          householdId,
          receipt: { is: null },
          occurredOn: { gte: from, lte: to },
          AND: [
            // Same amount + P2P-in/out scoping + send/receive direction gate
            // matchReceipts uses (item 3/4, 2026-08-29).
            receiptAmountWhere(r, r.totalCents!),
            receiptChargeScopeWhere(r),
          ],
        },
        select: {
          id: true,
          merchant: true,
          rawDescription: true,
          amountCents: true,
          occurredOn: true,
          account: { select: { name: true, displayName: true } },
        },
      })
    )
      // The picker deliberately does NOT apply plausibleReceiptCharge: a
      // household knows "Classifieds.com" bills as "Mountain Digital Media" and can
      // pick it in one click, where the name-resemblance auto-matcher never
      // could (2026-08-31 household request). Just surface every same-amount,
      // right-sign, in-window charge, closest date first, capped.
      .sort(
        (a, b) =>
          Math.abs(a.occurredOn.getTime() - anchor.getTime()) -
          Math.abs(b.occurredOn.getTime() - anchor.getTime()),
      )
      .slice(0, 6);

    // Split-total combos (see findComboCandidates above) — same window and
    // sign/P2P scoping as `cands`, just without the single-amount filter. No
    // `take` at the query level: a plain DB `take` with no `orderBy` returns
    // whatever rows Postgres feels like, which silently dropped the real
    // pair on a household with 100+ debits in a 16-day window (real bug,
    // 2026-09-04 — the Cedar Creek Irrigation $35+$2 split never turned up a
    // combo because neither leg happened to land in the arbitrary first 25
    // rows). Fetch the whole window, then rank by closeness to the
    // receipt's own date (same idiom as `cands` above) and cap in JS —
    // guarantees the actually-relevant transactions survive the cap
    // regardless of how busy the window is, and 100-200 rows makes the
    // pairwise search below trivially cheap either way.
    const comboPool = (
      r.totalCents == null
        ? []
        : await db.transaction.findMany({
            where: {
              householdId,
              receipt: { is: null },
              extraLegReceiptId: null,
              occurredOn: { gte: from, lte: to },
              // A combo only ever makes sense against real household spend —
              // the single-amount `cands` list above is narrow enough (an
              // exact amount match) that a non-budget-tracked card's own
              // bookkeeping (interest charges, its own payment, cashback —
              // never a real purchase a receipt would describe) rarely
              // collides by chance; the combo search's much wider pool makes
              // that collision common (real case, 2026-09-04: a $2.00 fee +
              // a $0.94 Quicksilver "Interest Charge" coincidentally summed
              // to an unrelated Capital One $2.94 rewards-credit receipt).
              account: { is: { budgetTracked: true } },
              AND: [receiptChargeScopeWhere(r)],
            },
            select: {
              id: true,
              merchant: true,
              rawDescription: true,
              amountCents: true,
              occurredOn: true,
              account: { select: { name: true, displayName: true } },
            },
          })
    )
      .filter((t) => receiptSignMatches(r, t.amountCents))
      .sort((a, b) => Math.abs(a.occurredOn.getTime() - anchor.getTime()) - Math.abs(b.occurredOn.getTime() - anchor.getTime()))
      .slice(0, 150);
    const aliasMerchants = r.party ? aliasByParty.get(aliasKey(r.party)) : undefined;
    const combos =
      r.totalCents == null
        ? []
        : findComboCandidates(comboPool, r.totalCents, (t) =>
            plausibleReceiptCharge(r, { merchant: t.merchant, rawDescription: t.rawDescription }, aliasMerchants),
          );

    linkRows.push({
      receipt: {
        id: r.id,
        party: r.party,
        p2pApp: r.p2pApp,
        totalCents: r.totalCents,
        occurredOn: ISO_DAY(r.occurredOn ?? r.receivedAt),
        itemSummary: summarizeItems(r.lineItems),
        noteText: r.noteText,
        kind: r.kind,
        isRefund: r.isRefund,
        refundTo: r.refundTo,
        refundToLast4: r.refundToLast4,
      },
      candidates: cands.map((c) => ({
        id: c.id,
        merchant: c.merchant,
        amountCents: c.amountCents,
        occurredOn: ISO_DAY(c.occurredOn),
        accountLabel: c.account ? (c.account.displayName ?? c.account.name) : null,
      })),
      comboCandidates: combos.map(([a, b]) =>
        [a, b].map((c) => ({
          id: c.id,
          merchant: c.merchant,
          amountCents: c.amountCents,
          occurredOn: ISO_DAY(c.occurredOn),
          accountLabel: c.account ? (c.account.displayName ?? c.account.name) : null,
        })),
      ),
      planCandidates:
        r.totalCents == null
          ? []
          : installmentPlans
              .filter((p) => {
                const original = bnplPlanOriginalPrincipalCents({
                  name: p.name,
                  balanceCents: p.balanceCents,
                  minPaymentCents: p.minPaymentCents,
                  installmentsTotal: p.installmentsTotal,
                  purchaseDate: p.purchaseDate,
                  perInstallmentCents: p.debtPayment?.amountDueCents ?? null,
                });
                return (
                  original != null &&
                  bnplPlanTotalMatches(original, r.totalCents!) &&
                  bnplPlanDateInWindow(p.purchaseDate, r.occurredOn ?? r.receivedAt)
                );
              })
              .map((p) => ({
                id: p.id,
                name: p.name,
                label: p.label,
                installmentsTotal: p.installmentsTotal,
              })),
    });
  }

  const unmatchedBillNotices = hasConnection ? await getUnmatchedBillNotices(userId) : [];
  const [billCandidates, debtCandidates] =
    unmatchedBillNotices.length > 0
      ? await Promise.all([
          db.recurringBill.findMany({ where: { householdId, active: true }, select: { id: true, name: true } }),
          db.debt.findMany({
            where: { householdId, hiddenAt: null, debtPayment: { isNot: null } },
            select: { id: true, name: true, account: { select: { displayName: true } } },
          }).then((rows) => rows.map((d) => ({ id: d.id, name: debtDisplayName(d) }))),
        ])
      : [[] as LinkCandidate[], [] as LinkCandidate[]];

  // With unmatched receipts/bill notices to work through, the connection
  // panel becomes a sticky rail beside the linker list; otherwise it's just
  // a form — keep it a centered reading column.
  const hasUnmatched = linkRows.length > 0 || unmatchedBillNotices.length > 0;

  const connectionPanel = (
    <>
      <EmailUsageSynopsis />
      <EmailSettingsPanel
        connections={connections.map((c) => ({
          id: c.id,
          imapUser: c.imapUser,
          status: c.status,
          lastError: c.lastError,
        }))}
        initialStatus={{
          connected: hasConnection,
          scanning: isHouseholdScanning(householdId),
          parsedCount,
          awaitingCount: linkRows.length,
          lastPolledAt: lastPolledAt ? lastPolledAt.toISOString() : null,
        }}
      />
    </>
  );

  return (
    <AppShell
      title="Email Receipts"
      user={session.user}
      breadcrumb={{ href: "/settings", label: "Settings" }}
      width={hasUnmatched ? "wide" : "reading"}
    >
      {hasUnmatched ? (
        <div className="flex flex-col gap-6 lg:grid lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)] lg:gap-6 lg:items-start">
          <div className="flex flex-col gap-6 lg:sticky lg:top-4">{connectionPanel}</div>
          <div className="flex flex-col gap-2">
            <h2 className="text-sm font-semibold text-amber-800 dark:text-amber-300">
              Receipts We Couldn&apos;t Match
            </h2>
            <p className="text-xs text-gray-500 dark:text-neutral-400">
              These didn&apos;t line up with a single charge on their own — pick
              the charge each one belongs to, or mark it as not a household
              purchase.
            </p>
            {linkRows.map((row) => (
              <ReceiptLinker
                key={row.receipt.id}
                receipt={row.receipt}
                candidates={row.candidates}
                comboCandidates={row.comboCandidates}
                planCandidates={row.planCandidates}
              />
            ))}
            {unmatchedBillNotices.length > 0 && (
              <>
                <h2 className="mt-4 text-sm font-semibold text-amber-800 dark:text-amber-300">
                  Bill Notices We Couldn&apos;t Match
                </h2>
                <p className="text-xs text-gray-500 dark:text-neutral-400">
                  These didn&apos;t line up with a tracked bill or debt by name —
                  pick which one each belongs to, or mark it as not one you
                  track.
                </p>
                {unmatchedBillNotices.map((notice) => (
                  <BillNoticeLinker
                    key={notice.id}
                    notice={{
                      id: notice.id,
                      billerName: notice.billerName,
                      amountDueCents: notice.amountDueCents,
                      dueDate: notice.dueDate ? notice.dueDate.toISOString().slice(0, 10) : null,
                    }}
                    billCandidates={billCandidates}
                    debtCandidates={debtCandidates}
                  />
                ))}
              </>
            )}
          </div>
        </div>
      ) : (
        connectionPanel
      )}
    </AppShell>
  );
}

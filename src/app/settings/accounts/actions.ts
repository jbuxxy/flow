"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { hasFullAccess, requireOwner, belongsToHousehold } from "@/lib/access";
import { encrypt } from "@/lib/crypto";
import { claimSetupToken } from "@/lib/simplefin";
import { syncHousehold } from "@/lib/simplefin-sync";
import { purgeCutoffDate } from "@/lib/hidden-items";

export type ConnectState = { error?: string };

const connectSchema = z.object({ setupToken: z.string().trim().min(1) });

export async function connectSimpleFin(
  _prev: ConnectState,
  formData: FormData,
): Promise<ConnectState> {
  const session = await requireOwner();

  const parsed = connectSchema.safeParse({ setupToken: formData.get("setupToken") });
  if (!parsed.success) return { error: "Paste your SimpleFIN setup token." };

  const existing = await db.bankConnection.findUnique({
    where: { householdId: session.user.householdId },
  });
  if (existing) return { error: "Already connected. Disconnect first to reconnect." };

  let accessUrl: string;
  try {
    accessUrl = await claimSetupToken(parsed.data.setupToken);
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Failed to claim setup token." };
  }

  await db.bankConnection.create({
    data: {
      householdId: session.user.householdId,
      accessUrlEncrypted: encrypt(accessUrl),
    },
  });

  try {
    await syncHousehold(session.user.householdId);
  } catch (err) {
    // Connection is saved even if the first sync fails (e.g. transient
    // network issue) — status/lastError on BankConnection reflects it, and
    // the user can retry with "Sync now".
    console.error("Initial SimpleFIN sync failed:", err);
  }

  revalidatePath("/settings/accounts");
  return {};
}

export async function syncNow() {
  const session = await requireOwner();
  await syncHousehold(session.user.householdId);
  revalidatePath("/settings/accounts");
  revalidatePath("/debts");
  revalidatePath("/savings");
  revalidatePath("/buckets");
}

export async function disconnectSimpleFin() {
  const session = await requireOwner();
  await db.bankConnection.delete({ where: { householdId: session.user.householdId } });
  revalidatePath("/settings/accounts");
}

// The manual override for Account.budgetTracked (2026-08-14, generalized to
// every account type 2026-08-15) — lets a household flip any account's
// spend in or out of the auto-categorization pipeline. Originally
// CREDIT_CARD/LOAN-only (e.g. one deliberately used for points, paid off
// from checking every cycle) but a household can also have more than one
// CHECKING account and only want one of them driving the real budget — see
// the schema comment on Account.budgetTracked for the full rationale.
export async function setAccountBudgetTracked(accountId: string, budgetTracked: boolean) {
  const session = await requireOwner();

  const account = await db.account.findUnique({ where: { id: accountId } });
  if (!belongsToHousehold(account, session.user.householdId)) return;

  await db.account.update({ where: { id: accountId }, data: { budgetTracked } });
  revalidatePath("/settings/accounts");
  revalidatePath("/buckets");
}

const renameAccountSchema = z.object({
  name: z.string().trim().min(1).max(80),
});

export type RenameAccountState = { error?: string };

// Sets Account.displayName rather than name — see the schema comment on
// that field for why: `name` is overwritten by SimpleFIN's raw account
// name on every sync, so a custom label needs a separate field to survive.
// Was CHECKING/SAVINGS-only (renameCashAccount, on /networth) — generalized
// to every account type and relocated here as part of the 2026-08-15
// account-settings consolidation, since a debt's only prior "friendly name"
// was a one-time, never-updated copy of the raw synced name (see
// Debt.name's creation sites in simplefin-sync.ts/debts/actions.ts) with no
// rename affordance of its own. Every place a debt/account name renders now
// prefers this over the raw name/Debt.name — see WORKING_ON.md.
export async function renameAccount(
  accountId: string,
  _prev: RenameAccountState,
  formData: FormData,
): Promise<RenameAccountState> {
  const session = await auth();
  if (!session?.user) redirect("/login");
  if (!hasFullAccess(session.user)) return { error: "Not authorized." };

  const account = await db.account.findUnique({ where: { id: accountId } });
  if (!belongsToHousehold(account, session.user.householdId)) return { error: "Not found." };

  const parsed = renameAccountSchema.safeParse({ name: formData.get("name") });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input" };

  await db.account.update({ where: { id: accountId }, data: { displayName: parsed.data.name } });
  revalidatePath("/settings/accounts");
  revalidatePath("/networth");
  revalidatePath("/debts");
  revalidatePath("/buckets");
  revalidatePath("/transactions");
  return {};
}

export type UpdateAccountApyState = { error?: string };

// Manually entered only — SimpleFIN has no rates API (see the schema comment
// on Account.apyBasisPoints). Optional for every non-debt account type
// (CHECKING/SAVINGS/INVESTMENT/OTHER) — a CREDIT_CARD/LOAN account already
// carries its own rate via the linked Debt's aprBasisPoints (the debt-terms
// fields above), so this field only applies where APR doesn't. Was
// SAVINGS-only and lived on /networth's CashAccountRow until 2026-08-26,
// when it moved here to sit alongside every other account-level field
// instead of splitting editing across two pages.
export async function updateAccountApy(
  accountId: string,
  _prev: UpdateAccountApyState,
  formData: FormData,
): Promise<UpdateAccountApyState> {
  const session = await auth();
  if (!session?.user) redirect("/login");
  if (!hasFullAccess(session.user)) return { error: "Not authorized." };

  const account = await db.account.findUnique({ where: { id: accountId } });
  if (!belongsToHousehold(account, session.user.householdId)) return { error: "Not found." };

  const raw = String(formData.get("apy") ?? "").replace(/%/g, "").trim();
  let apyBasisPoints: number | null = null;
  if (raw !== "") {
    const value = Number(raw);
    if (!Number.isFinite(value)) return { error: "Invalid APY." };
    apyBasisPoints = Math.max(0, Math.round(value * 100));
  }

  await db.account.update({ where: { id: accountId }, data: { apyBasisPoints } });
  revalidatePath("/settings/accounts");
  revalidatePath("/networth");
  revalidatePath("/reports");
  return {};
}

// There's deliberately no manual "hide this account" action — an Account
// only ever goes hidden by actually being gone from SimpleFIN
// (hideAccountsWithLinkedDebts, src/lib/simplefin-sync.ts, called from
// syncHousehold's own vanish detection, cascading to any linked Debt too).
// The nearest a household gets to hiding a still-connected account by hand
// is hideDebt (src/app/debts/actions.ts) on its linked Debt — but that only
// works at a $0 balance, and only ever touches the Debt's own hiddenAt, not
// this Account's. A still-connected account's purge clock therefore never
// starts on its own, no matter how its debt is paid off or hidden.

// Undoes hideAccountsWithLinkedDebts — available any time, not gated behind
// the year-old purge-eligibility window deleteHiddenItem uses below, same
// reasoning as restoreDebt (src/app/debts/actions.ts). Cascades to restore
// any linked Debt too, mirroring the hide cascade, so a household doesn't
// end up with the account back but its debt card still missing.
export async function restoreAccount(accountId: string) {
  const session = await requireOwner();

  const account = await db.account.findUnique({ where: { id: accountId }, select: { householdId: true } });
  if (!belongsToHousehold(account, session.user.householdId)) return;

  // missingFromFeedSince cleared too — a stale miss-timer from whatever
  // vanished it the first time shouldn't count toward re-hiding it again on
  // the very next sync; it starts the debounce window fresh, same as any
  // other account currently showing up in the feed (see
  // GONE_FROM_FEED_GRACE_MS in simplefin-sync.ts).
  await db.account.update({ where: { id: accountId }, data: { hiddenAt: null, missingFromFeedSince: null } });
  await db.debt.updateMany({ where: { accountId }, data: { hiddenAt: null } });
  revalidatePath("/settings/hidden");
  revalidatePath("/settings/accounts");
  revalidatePath("/debts");
  revalidatePath("/buckets");
  revalidatePath("/networth");
  revalidatePath("/savings");
  revalidatePath("/transactions");
  revalidatePath("/");
}

// The household-triggered "actually delete it now" for a single hidden
// Debt or Account. Re-derives eligibility server-side rather than trusting
// the caller: a debt entered by hand (source MANUAL, no linked account) can
// go immediately; anything that came from a sync — an Account that vanished
// from the feed, or a Debt still linked to one — keeps the year-old
// purgeCutoffDate() safety delay, since those can't self-heal back into
// view and a household might still be waiting on the institution.
//
// Deleting a Debt cascades: its DebtPayment / DebtBalanceReview /
// PayoffExtraConfirmation / PayoffExtraSkip rows go with it (onDelete:
// Cascade), while any
// matched Transaction, RecurringPattern, MerchantRule, or secured Asset
// keeps its row and just has the debt link nulled (onDelete: SetNull).
// Deleting an Account nulls the account link on its Transactions / Assets /
// SavingsGoals / Incomes the same way — except a still-hidden linked Debt
// (the "linked" row in getHiddenItems, hidden alongside this same account),
// which is deleted right along with it rather than left behind as an
// orphan; a *visible* debt whose account gets deleted (not reachable from
// this hidden-items purge flow, but possible elsewhere) still just has its
// account link nulled. Transaction history is never removed either way.
export async function deleteHiddenItem(kind: "debt" | "account", id: string) {
  const session = await requireOwner();
  const cutoff = purgeCutoffDate();

  if (kind === "debt") {
    const debt = await db.debt.findUnique({
      where: { id },
      select: { householdId: true, hiddenAt: true, source: true, accountId: true },
    });
    if (!belongsToHousehold(debt, session.user.householdId) || !debt.hiddenAt) return;
    const manual = debt.source === "MANUAL" && debt.accountId === null;
    if (!manual && debt.hiddenAt >= cutoff) return;
    await db.debt.delete({ where: { id } });
  } else {
    const account = await db.account.findUnique({
      where: { id },
      select: { householdId: true, hiddenAt: true },
    });
    if (!belongsToHousehold(account, session.user.householdId) || !account.hiddenAt) return;
    if (account.hiddenAt >= cutoff) return;
    // A still-hidden Debt still linked to this account is the same "one
    // hidden card" the household is deleting here (see the "linked" row in
    // getHiddenItems) — without this it'd survive as an orphaned debt with
    // its account link merely nulled (the FK's own onDelete: SetNull),
    // which is right for a *visible* debt losing its account but wrong for
    // one that was only ever hidden because this account was.
    await db.debt.deleteMany({ where: { accountId: id, hiddenAt: { not: null } } });
    await db.account.delete({ where: { id } });
  }

  revalidatePath("/settings/hidden");
  revalidatePath("/settings/accounts");
  revalidatePath("/settings/database");
  revalidatePath("/debts");
  revalidatePath("/buckets");
  revalidatePath("/networth");
  revalidatePath("/savings");
  revalidatePath("/transactions");
  revalidatePath("/");
}

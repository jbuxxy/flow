"use server";

import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { dismissUnlabeledP2PBoth } from "@/lib/p2p-transfers";
import { dismissUncategorized } from "@/lib/buckets";
import { dismissUntrackedLiability } from "@/lib/untracked-liabilities";
import { dismissStaleAsset } from "@/lib/networth";
import { dismissBillsThisWeek } from "@/lib/recurring-bills";
import { dismissPaidOffThisWeek } from "@/lib/debt-payments";
import { dismissReceiptMatchReview } from "@/lib/receipt-sync";
import { dismissRefundMatchReview } from "@/lib/refund-match";
import { dismissPayday } from "@/lib/income";
import { revalidateHousehold } from "@/lib/revalidate";

export async function dismissUnlabeledP2PFromDashboard() {
  const session = await auth();
  if (!session?.user) redirect("/login");
  await dismissUnlabeledP2PBoth(session.user.householdId);
  revalidateHousehold();
}

export async function dismissUncategorizedFromDashboard() {
  const session = await auth();
  if (!session?.user) redirect("/login");
  // Only the dashboard reminder — deliberately doesn't touch /buckets'
  // UncategorizedList, which always shows the real backlog regardless (see
  // getActiveUncategorizedCount's comment in buckets.ts).
  await dismissUncategorized(session.user.householdId);
  revalidateHousehold();
}

export async function dismissUntrackedLiabilityFromDashboard(accountId: string) {
  const session = await auth();
  if (!session?.user) redirect("/login");
  await dismissUntrackedLiability(session.user.householdId, accountId);
  revalidateHousehold();
}

export async function dismissStaleAssetFromDashboard(assetId: string) {
  const session = await auth();
  if (!session?.user) redirect("/login");
  await dismissStaleAsset(session.user.householdId, assetId);
  revalidateHousehold();
}

export async function dismissBillsThisWeekFromDashboard() {
  const session = await auth();
  if (!session?.user) redirect("/login");
  await dismissBillsThisWeek(session.user.householdId);
  revalidateHousehold();
}

export async function dismissPaidOffThisWeekFromDashboard(debtIds: string[]) {
  const session = await auth();
  if (!session?.user) redirect("/login");
  await dismissPaidOffThisWeek(session.user.householdId, debtIds);
  revalidateHousehold();
}

export async function dismissReceiptMatchReviewFromDashboard() {
  const session = await auth();
  if (!session?.user) redirect("/login");
  await dismissReceiptMatchReview(session.user.householdId);
  revalidateHousehold();
}

export async function dismissRefundMatchReviewFromDashboard() {
  const session = await auth();
  if (!session?.user) redirect("/login");
  await dismissRefundMatchReview(session.user.householdId);
  revalidateHousehold();
}

export async function dismissPaydayFromDashboard(keys: string[]) {
  const session = await auth();
  if (!session?.user) redirect("/login");
  await dismissPayday(session.user.householdId, keys);
  revalidateHousehold();
}

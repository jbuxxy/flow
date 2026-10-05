"use server";

import { revalidatePath } from "next/cache";
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

export async function dismissUnlabeledP2PFromDashboard() {
  const session = await auth();
  if (!session?.user) redirect("/login");
  await dismissUnlabeledP2PBoth(session.user.householdId);
  revalidatePath("/");
  revalidatePath("/buckets");
  revalidatePath("/income");
}

export async function dismissUncategorizedFromDashboard() {
  const session = await auth();
  if (!session?.user) redirect("/login");
  // Only the dashboard reminder — deliberately doesn't touch /buckets'
  // UncategorizedList, which always shows the real backlog regardless (see
  // getActiveUncategorizedCount's comment in buckets.ts).
  await dismissUncategorized(session.user.householdId);
  revalidatePath("/");
}

export async function dismissUntrackedLiabilityFromDashboard(accountId: string) {
  const session = await auth();
  if (!session?.user) redirect("/login");
  await dismissUntrackedLiability(session.user.householdId, accountId);
  revalidatePath("/");
}

export async function dismissStaleAssetFromDashboard(assetId: string) {
  const session = await auth();
  if (!session?.user) redirect("/login");
  await dismissStaleAsset(session.user.householdId, assetId);
  revalidatePath("/");
}

export async function dismissBillsThisWeekFromDashboard() {
  const session = await auth();
  if (!session?.user) redirect("/login");
  await dismissBillsThisWeek(session.user.householdId);
  revalidatePath("/");
}

export async function dismissPaidOffThisWeekFromDashboard(debtIds: string[]) {
  const session = await auth();
  if (!session?.user) redirect("/login");
  await dismissPaidOffThisWeek(session.user.householdId, debtIds);
  revalidatePath("/");
}

export async function dismissReceiptMatchReviewFromDashboard() {
  const session = await auth();
  if (!session?.user) redirect("/login");
  await dismissReceiptMatchReview(session.user.householdId);
  revalidatePath("/");
}

export async function dismissRefundMatchReviewFromDashboard() {
  const session = await auth();
  if (!session?.user) redirect("/login");
  await dismissRefundMatchReview(session.user.householdId);
  revalidatePath("/");
}

export async function dismissPaydayFromDashboard(keys: string[]) {
  const session = await auth();
  if (!session?.user) redirect("/login");
  await dismissPayday(session.user.householdId, keys);
  revalidatePath("/");
}

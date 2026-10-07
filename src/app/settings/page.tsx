import Link from "next/link";
import { redirect } from "next/navigation";
import { Users, Landmark, Sparkles, Database, House, Wallet, Bell, ChevronRight, CalendarDays, EyeOff, Mail, ScanFace } from "lucide-react";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { hasFullAccess } from "@/lib/access";
import { getHiddenItems } from "@/lib/hidden-items";
import { needsBankConnectionAttention } from "@/lib/bank-connection";
import { hasDebtsNeedingAttention } from "@/lib/debt-payments";
import { needsAiAttention } from "@/lib/ai-provider";
import { emailConnectionHasError } from "@/lib/email-provider";
import { AppShell } from "@/components/app-shell";
import { NotificationToggle } from "@/components/notification-toggle";
import { NotificationBadgeDot } from "@/components/notification-badge-dot";
import { GOAL_POSTURE_LABEL } from "@/lib/goal-posture";
import { DangerZone } from "./danger-zone";
import { InstallAppCard } from "./install-app-card";

const INCOME_METHOD_LABEL: Record<string, string> = {
  MONTHLY_AVERAGE: "Monthly Average",
  BIWEEKLY_CONSERVATIVE: "Biweekly × 2",
};

export default async function SettingsPage() {
  const session = await auth();
  if (!session?.user) redirect("/login");

  const household = await db.household.findUnique({ where: { id: session.user.householdId } });
  const isOwner = session.user.role === "OWNER";
  // Owner-only — adding/editing members is a management action, not
  // something a Partner (full-financials, non-owner) gets to do.
  const canManageMembers = isOwner;
  // Account Sync's row dot covers both a bank-connection problem and an
  // unconfirmed/misclassified debt — this page renders the same per-debt
  // "needs setup" rows /debts does, so a debt issue is just as fixable from
  // here (2026-08-19, matches app-shell.tsx's settingsNeedsAttention).
  const [bankConnectionNeedsAttention, debtsNeedAttention] = hasFullAccess(session.user)
    ? await Promise.all([
        needsBankConnectionAttention(session.user.householdId),
        hasDebtsNeedingAttention(session.user.householdId),
      ])
    : [false, false];
  const bankNeedsAttention = bankConnectionNeedsAttention || debtsNeedAttention;
  const aiNeedsAttention = isOwner ? await needsAiAttention(session.user.householdId) : false;
  // Per-user, not per-household — each member's own mailbox connection. Only
  // ever a configured-but-broken row (email is optional, so "not connected"
  // is not an error and there's no attention badge, just red subtitle text).
  const emailConnectionError = hasFullAccess(session.user)
    ? await emailConnectionHasError(session.user.id)
    : false;
  const hiddenCount = isOwner ? (await getHiddenItems(session.user.householdId)).length : 0;
  const notifState = await db.user.findUnique({
    where: { id: session.user.id },
    select: { notificationsEnabled: true, notificationsLocked: true },
  });

  return (
    <AppShell title="Settings" user={session.user}>
      <div className="rounded-2xl border border-blue-100 dark:border-neutral-800 p-4">
        <h2 className="text-sm font-semibold text-emerald-700 dark:text-emerald-400">Notifications</h2>
        <div className="mt-3">
          <NotificationToggle
            showUnavailableWarning
            lockedOn={!!notifState?.notificationsLocked && !!notifState.notificationsEnabled}
          />
        </div>
      </div>

      <InstallAppCard />

      <div className="flex flex-col gap-2 lg:grid lg:grid-cols-2 lg:items-start xl:grid-cols-3">
        <Link
          href="/settings/notifications"
          className="flex items-center justify-between rounded-xl border border-blue-100 dark:border-neutral-800 p-4"
        >
          <span className="flex items-center gap-3">
            <span className="flex h-9 w-9 items-center justify-center rounded-full bg-blue-50 dark:bg-neutral-800 text-blue-900 dark:text-blue-300">
              <Bell size={18} />
            </span>
            <span>
              <p className="text-sm font-medium text-neutral-900 dark:text-neutral-100">Notification Preferences</p>
              <p className="text-xs text-gray-500 dark:text-neutral-400">
                {isOwner ? "Choose what each member gets notified about" : "Choose what you get notified about"}
              </p>
            </span>
          </span>
          <NotificationBadgeDot />
          <ChevronRight size={18} className="text-gray-400 dark:text-neutral-500" />
        </Link>

        <Link
          href="/settings/security"
          className="flex items-center justify-between rounded-xl border border-blue-100 dark:border-neutral-800 p-4"
        >
          <span className="flex items-center gap-3">
            <span className="flex h-9 w-9 items-center justify-center rounded-full bg-blue-50 dark:bg-neutral-800 text-blue-900 dark:text-blue-300">
              <ScanFace size={18} />
            </span>
            <span>
              <p className="text-sm font-medium text-neutral-900 dark:text-neutral-100">Sign-In & Security</p>
              <p className="text-xs text-gray-500 dark:text-neutral-400">Sign in with a passkey instead of a password</p>
            </span>
          </span>
          <ChevronRight size={18} className="text-gray-400 dark:text-neutral-500" />
        </Link>

        {hasFullAccess(session.user) && household && (
          <Link
            href="/settings/income"
            className="flex items-center justify-between rounded-xl border border-blue-100 dark:border-neutral-800 p-4"
          >
            <span className="flex items-center gap-3">
              <span className="flex h-9 w-9 items-center justify-center rounded-full bg-blue-50 dark:bg-neutral-800 text-blue-900 dark:text-blue-300">
                <Wallet size={18} />
              </span>
              <span>
                <p className="text-sm font-medium text-neutral-900 dark:text-neutral-100">
                  Income for Budgeting
                </p>
                <p className="text-xs text-gray-500 dark:text-neutral-400">
                  {INCOME_METHOD_LABEL[household.incomeCalcMethod] ?? household.incomeCalcMethod}
                  {household.includeP2PInIncomeCalc ? " · P2P included" : ""}
                </p>
              </span>
            </span>
            <ChevronRight size={18} className="text-gray-400 dark:text-neutral-500" />
          </Link>
        )}

        {hasFullAccess(session.user) && household && (
          <Link
            href="/settings/household"
            className="flex items-center justify-between rounded-xl border border-blue-100 dark:border-neutral-800 p-4"
          >
            <span className="flex items-center gap-3">
              <span className="flex h-9 w-9 items-center justify-center rounded-full bg-blue-50 dark:bg-neutral-800 text-blue-900 dark:text-blue-300">
                <House size={18} />
              </span>
              <span>
                <p className="text-sm font-medium text-neutral-900 dark:text-neutral-100">
                  Household Profile
                </p>
                <p className="text-xs text-gray-500 dark:text-neutral-400">
                  {GOAL_POSTURE_LABEL[household.goalPosture] ?? household.goalPosture} · {household.adultsCount}{" "}
                  adult{household.adultsCount === 1 ? "" : "s"}
                  {household.kidsCount > 0
                    ? `, ${household.kidsCount} kid${household.kidsCount === 1 ? "" : "s"}`
                    : ""}
                </p>
              </span>
            </span>
            <ChevronRight size={18} className="text-gray-400 dark:text-neutral-500" />
          </Link>
        )}

        {canManageMembers && (
          <Link
            href="/settings/members"
            className="flex items-center justify-between rounded-xl border border-blue-100 dark:border-neutral-800 p-4"
          >
            <span className="flex items-center gap-3">
              <span className="flex h-9 w-9 items-center justify-center rounded-full bg-blue-50 dark:bg-neutral-800 text-blue-900 dark:text-blue-300">
                <Users size={18} />
              </span>
              <span>
                <p className="text-sm font-medium text-neutral-900 dark:text-neutral-100">
                  Household Members
                </p>
                <p className="text-xs text-gray-500 dark:text-neutral-400">
                  Invite your spouse or a kid, manage 2FA
                </p>
              </span>
            </span>
            <ChevronRight size={18} className="text-gray-400 dark:text-neutral-500" />
          </Link>
        )}

        {hasFullAccess(session.user) && (
          <Link
            href="/settings/accounts"
            className="flex items-center justify-between rounded-xl border border-blue-100 dark:border-neutral-800 p-4"
          >
            <span className="flex items-center gap-3">
              <span className="flex h-9 w-9 items-center justify-center rounded-full bg-blue-50 dark:bg-neutral-800 text-blue-900 dark:text-blue-300">
                <Landmark size={18} />
              </span>
              <span>
                <p className="flex items-center gap-1.5 text-sm font-medium text-neutral-900 dark:text-neutral-100">
                  Account Sync
                  {bankNeedsAttention && (
                    <span className="h-2 w-2 shrink-0 rounded-full bg-red-600" aria-label="Needs Attention" />
                  )}
                </p>
                <p
                  className={`text-xs ${bankNeedsAttention ? "text-red-600 dark:text-red-400" : "text-gray-500 dark:text-neutral-400"}`}
                >
                  {bankNeedsAttention
                    ? "Needs Attention"
                    : isOwner
                      ? "Connect accounts, view sync status"
                      : "View connected accounts"}
                </p>
              </span>
            </span>
            <ChevronRight size={18} className="text-gray-400 dark:text-neutral-500" />
          </Link>
        )}
        {isOwner && (
          <Link
            href="/settings/ai"
            className="flex items-center justify-between rounded-xl border border-blue-100 dark:border-neutral-800 p-4"
          >
            <span className="flex items-center gap-3">
              <span className="flex h-9 w-9 items-center justify-center rounded-full bg-blue-50 dark:bg-neutral-800 text-blue-900 dark:text-blue-300">
                <Sparkles size={18} />
              </span>
              <span>
                <p className="flex items-center gap-1.5 text-sm font-medium text-neutral-900 dark:text-neutral-100">
                  AI Features
                  {aiNeedsAttention && (
                    <span className="h-2 w-2 shrink-0 rounded-full bg-red-600" aria-label="Needs Attention" />
                  )}
                </p>
                <p className={`text-xs ${aiNeedsAttention ? "text-red-600 dark:text-red-400" : "text-gray-500 dark:text-neutral-400"}`}>
                  {aiNeedsAttention ? "Needs Attention" : "Configure your AI provider"}
                </p>
              </span>
            </span>
            <ChevronRight size={18} className="text-gray-400 dark:text-neutral-500" />
          </Link>
        )}
        {hasFullAccess(session.user) && (
          <Link
            href="/settings/email"
            className="flex items-center justify-between rounded-xl border border-blue-100 dark:border-neutral-800 p-4"
          >
            <span className="flex items-center gap-3">
              <span className="flex h-9 w-9 items-center justify-center rounded-full bg-blue-50 dark:bg-neutral-800 text-blue-900 dark:text-blue-300">
                <Mail size={18} />
              </span>
              <span>
                <p className="text-sm font-medium text-neutral-900 dark:text-neutral-100">Email Receipts</p>
                <p
                  className={`text-xs ${emailConnectionError ? "text-red-600 dark:text-red-400" : "text-gray-500 dark:text-neutral-400"}`}
                >
                  {emailConnectionError
                    ? "Reconnect your inbox"
                    : "Attach receipt detail from your inbox to charges"}
                </p>
              </span>
            </span>
            <ChevronRight size={18} className="text-gray-400 dark:text-neutral-500" />
          </Link>
        )}
        {isOwner && (
          <Link
            href="/settings/calendar-sync"
            className="flex items-center justify-between rounded-xl border border-blue-100 dark:border-neutral-800 p-4"
          >
            <span className="flex items-center gap-3">
              <span className="flex h-9 w-9 items-center justify-center rounded-full bg-blue-50 dark:bg-neutral-800 text-blue-900 dark:text-blue-300">
                <CalendarDays size={18} />
              </span>
              <span>
                <p className="text-sm font-medium text-neutral-900 dark:text-neutral-100">Calendar Sync</p>
                <p className="text-xs text-gray-500 dark:text-neutral-400">
                  Subscribe to the payment calendar from Google or Apple Calendar
                </p>
              </span>
            </span>
            <ChevronRight size={18} className="text-gray-400 dark:text-neutral-500" />
          </Link>
        )}
        {isOwner && (
          <Link
            href="/settings/database"
            className="flex items-center justify-between rounded-xl border border-blue-100 dark:border-neutral-800 p-4"
          >
            <span className="flex items-center gap-3">
              <span className="flex h-9 w-9 items-center justify-center rounded-full bg-blue-50 dark:bg-neutral-800 text-blue-900 dark:text-blue-300">
                <Database size={18} />
              </span>
              <span>
                <p className="text-sm font-medium text-neutral-900 dark:text-neutral-100">Database</p>
                <p className="text-xs text-gray-500 dark:text-neutral-400">
                  Export/backup, wipe financial data, restart setup
                </p>
              </span>
            </span>
            <ChevronRight size={18} className="text-gray-400 dark:text-neutral-500" />
          </Link>
        )}
        {isOwner && hiddenCount > 0 && (
          <Link
            href="/settings/hidden"
            className="flex items-center justify-between rounded-xl border border-blue-100 dark:border-neutral-800 p-4"
          >
            <span className="flex items-center gap-3">
              <span className="flex h-9 w-9 items-center justify-center rounded-full bg-blue-50 dark:bg-neutral-800 text-blue-900 dark:text-blue-300">
                <EyeOff size={18} />
              </span>
              <span>
                <p className="text-sm font-medium text-neutral-900 dark:text-neutral-100">
                  Hidden Accounts &amp; Debts
                </p>
                <p className="text-xs text-gray-500 dark:text-neutral-400">
                  {hiddenCount} {hiddenCount === 1 ? "item" : "items"} hidden — restore or permanently delete
                </p>
              </span>
            </span>
            <ChevronRight size={18} className="text-gray-400 dark:text-neutral-500" />
          </Link>
        )}
      </div>

      {!canManageMembers && !hasFullAccess(session.user) && (
        <p className="text-sm text-gray-500 dark:text-neutral-400">
          Nothing to manage here yet — your account is scoped to buckets and
          budget only.
        </p>
      )}

      {isOwner && household && <DangerZone householdName={household.name} />}
    </AppShell>
  );
}

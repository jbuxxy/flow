import Link from "next/link";
import { redirect } from "next/navigation";
import { Users, Landmark, Sparkles, Database, House, Wallet, Bell, ChevronRight, CalendarDays, EyeOff, Mail, ScanFace, type LucideIcon } from "lucide-react";
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
import { NotificationSettingsCard } from "@/components/notification-settings-card";
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
  const fullAccess = hasFullAccess(session.user);
  // Account Sync's row dot covers both a bank-connection problem and an
  // unconfirmed/misclassified debt — this page renders the same per-debt
  // "needs setup" rows /debts does, so a debt issue is just as fixable from
  // here (2026-08-19, matches app-shell.tsx's settingsNeedsAttention).
  // Email: per-user, not per-household — each member's own mailbox
  // connection. Only ever a configured-but-broken row (email is optional, so
  // "not connected" is not an error and there's no attention badge, just red
  // subtitle text).
  const [bankConnectionNeedsAttention, debtsNeedAttention, aiNeedsAttention, emailConnectionError, hiddenItems, notifState] =
    await Promise.all([
      fullAccess ? needsBankConnectionAttention(session.user.householdId) : false,
      fullAccess ? hasDebtsNeedingAttention(session.user.householdId) : false,
      isOwner ? needsAiAttention(session.user.householdId) : false,
      fullAccess ? emailConnectionHasError(session.user.id) : false,
      isOwner ? getHiddenItems(session.user.householdId) : [],
      db.user.findUnique({
        where: { id: session.user.id },
        select: { notificationsEnabled: true, notificationsLocked: true },
      }),
    ]);
  const bankNeedsAttention = bankConnectionNeedsAttention || debtsNeedAttention;
  const hiddenCount = hiddenItems.length;

  return (
    <AppShell title="Settings" user={session.user}>
      <NotificationSettingsCard>
        <div className="mt-3">
          <NotificationToggle
            showUnavailableWarning
            lockedOn={!!notifState?.notificationsLocked && !!notifState.notificationsEnabled}
          />
        </div>
      </NotificationSettingsCard>

      <InstallAppCard />

      <div className="flex flex-col gap-2 lg:grid lg:grid-cols-2 lg:items-start xl:grid-cols-3">
        <SettingsLink
          href="/settings/notifications"
          icon={Bell}
          title="Notification Preferences"
          subtitle={isOwner ? "Choose what each member gets notified about" : "Choose what you get notified about"}
        />
        <SettingsLink
          href="/settings/security"
          icon={ScanFace}
          title="Sign-In & Security"
          subtitle="Sign in with a passkey instead of a password"
        />
        {fullAccess && household && (
          <SettingsLink
            href="/settings/income"
            icon={Wallet}
            title="Income for Budgeting"
            subtitle={`${INCOME_METHOD_LABEL[household.incomeCalcMethod] ?? household.incomeCalcMethod}${
              household.includeP2PInIncomeCalc ? " · P2P included" : ""
            }`}
          />
        )}
        {fullAccess && household && (
          <SettingsLink
            href="/settings/household"
            icon={House}
            title="Household Profile"
            subtitle={`${GOAL_POSTURE_LABEL[household.goalPosture] ?? household.goalPosture} · ${household.adultsCount} adult${
              household.adultsCount === 1 ? "" : "s"
            }${household.kidsCount > 0 ? `, ${household.kidsCount} kid${household.kidsCount === 1 ? "" : "s"}` : ""}`}
          />
        )}
        {canManageMembers && (
          <SettingsLink
            href="/settings/members"
            icon={Users}
            title="Household Members"
            subtitle="Invite your spouse or a kid, manage 2FA"
          />
        )}
        {fullAccess && (
          <SettingsLink
            href="/settings/accounts"
            icon={Landmark}
            title="Account Sync"
            attention={bankNeedsAttention}
            dot
            subtitle={
              bankNeedsAttention
                ? "Needs Attention"
                : isOwner
                  ? "Connect accounts, view sync status"
                  : "View connected accounts"
            }
          />
        )}
        {isOwner && (
          <SettingsLink
            href="/settings/ai"
            icon={Sparkles}
            title="AI Features"
            attention={aiNeedsAttention}
            dot
            subtitle={aiNeedsAttention ? "Needs Attention" : "Configure your AI provider"}
          />
        )}
        {fullAccess && (
          <SettingsLink
            href="/settings/email"
            icon={Mail}
            title="Email Receipts"
            attention={emailConnectionError}
            subtitle={emailConnectionError ? "Reconnect your inbox" : "Attach receipt detail from your inbox to charges"}
          />
        )}
        {isOwner && (
          <SettingsLink
            href="/settings/calendar-sync"
            icon={CalendarDays}
            title="Calendar Sync"
            subtitle="Subscribe to the payment calendar from Google or Apple Calendar"
          />
        )}
        {isOwner && (
          <SettingsLink
            href="/settings/database"
            icon={Database}
            title="Database"
            subtitle="Export/backup, wipe financial data, restart setup"
          />
        )}
        {isOwner && hiddenCount > 0 && (
          <SettingsLink
            href="/settings/hidden"
            icon={EyeOff}
            title="Hidden Accounts & Debts"
            subtitle={`${hiddenCount} ${hiddenCount === 1 ? "item" : "items"} hidden — restore or permanently delete`}
          />
        )}
      </div>

      {!canManageMembers && !fullAccess && (
        <p className="text-sm text-gray-500 dark:text-neutral-400">
          Nothing to manage here yet — your account is scoped to buckets and
          budget only.
        </p>
      )}

      {isOwner && household && <DangerZone householdName={household.name} />}
    </AppShell>
  );
}

// One settings destination: icon, title, subtitle, chevron. `attention`
// turns the subtitle red; `dot` also puts the red dot beside the title.
function SettingsLink({
  href,
  icon: Icon,
  title,
  subtitle,
  attention = false,
  dot = false,
}: {
  href: string;
  icon: LucideIcon;
  title: string;
  subtitle: string;
  attention?: boolean;
  dot?: boolean;
}) {
  return (
    <Link
      href={href}
      className="flex items-center justify-between rounded-xl border border-blue-100 dark:border-neutral-800 p-4"
    >
      <span className="flex items-center gap-3">
        <span className="flex h-9 w-9 items-center justify-center rounded-full bg-blue-50 dark:bg-neutral-800 text-blue-900 dark:text-blue-300">
          <Icon size={18} />
        </span>
        <span>
          <p className="flex items-center gap-1.5 text-sm font-medium text-neutral-900 dark:text-neutral-100">
            {title}
            {dot && attention && <span className="h-2 w-2 shrink-0 rounded-full bg-red-600" aria-label="Needs Attention" />}
          </p>
          <p className={`text-xs ${attention ? "text-red-600 dark:text-red-400" : "text-gray-500 dark:text-neutral-400"}`}>
            {subtitle}
          </p>
        </span>
      </span>
      <ChevronRight size={18} className="text-gray-400 dark:text-neutral-500" />
    </Link>
  );
}


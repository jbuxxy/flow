import type { NotificationType } from "@prisma/client";
import { hasFullAccess } from "@/lib/access-rules";

// Groups the /settings/notifications grid into labeled sections, in display
// order — CATEGORY_ORDER below is this same order, kept as a separate const
// so member-notification-prefs.tsx doesn't have to re-derive it.
export type NotificationCategory = "Buckets" | "Needs Your Attention" | "Debts" | "Savings" | "Budget Cycle";

// Title Case labels/descriptions/category for every NotificationType — the
// single source of truth for the /settings/notifications grid (member-
// notification-prefs.tsx) so a new type only needs to be described here once.
export const NOTIFICATION_TYPE_META: Record<
  NotificationType,
  { label: string; description: string; category: NotificationCategory }
> = {
  BUCKET_WARNING: {
    label: "Bucket Warning",
    description: "A bucket has passed its warning threshold (80% by default).",
    category: "Buckets",
  },
  BUCKET_EXCEEDED: {
    label: "Bucket Full",
    description: "A bucket has hit or gone over its monthly cap.",
    category: "Buckets",
  },
  BUCKET_PACE: {
    label: "Spending Pace",
    description: "A bucket is on pace to overshoot its monthly cap.",
    category: "Buckets",
  },
  BUCKET_TRANSACTION: {
    label: "Every Bucket Transaction",
    description: "A push for every transaction posted to a bucket that has this turned on, with the running total vs. its cap.",
    category: "Buckets",
  },
  WEEKLY_BUCKET_REPORT: {
    label: "Weekly Bucket Digest",
    description: "Opt-in weekly spending update for buckets that enable it.",
    category: "Buckets",
  },
  BUCKET_TOPPED_UP: {
    label: "Bucket Topped Up From Extra Income",
    description: "Ad hoc/P2P income was auto-applied to cover a bucket that went over its cap.",
    category: "Buckets",
  },
  NEEDS_BUCKET: {
    label: "Needs A Bucket",
    description: "A transaction has sat uncategorized and needs a bucket picked.",
    category: "Needs Your Attention",
  },
  RECEIPT_NEEDS_REVIEW: {
    label: "Receipt Needs Review",
    description: "An email receipt matched more than one transaction and needs you to pick the right one.",
    category: "Needs Your Attention",
  },
  NEEDS_LABEL_P2P: {
    label: "P2P Needs A Label",
    description: "A Venmo/Zelle/PayPal-style transfer needs you to say what it actually was.",
    category: "Needs Your Attention",
  },
  NEEDS_REFUND_MATCH_REVIEW: {
    label: "Refund Needs Review",
    description: "A refund-looking credit matched more than one past purchase at that merchant and needs you to pick the right one.",
    category: "Needs Your Attention",
  },
  DEBT_AMOUNT_REVIEW: {
    label: "Debt Payment Review",
    description: "A debt payment came in different than expected.",
    category: "Debts",
  },
  BILL_AMOUNT_REVIEW: {
    label: "Bill Amount Review",
    description: "An email says a tracked bill's amount changed and needs you to confirm it.",
    category: "Needs Your Attention",
  },
  ACCOUNT_SYNC_ISSUE: {
    label: "Account Sync Issue",
    description: "The bank connection failed, or a linked account needs to be reconnected.",
    category: "Needs Your Attention",
  },
  DEBT_BALANCE_PAID_OFF_REVIEW: {
    label: "Debt Paid Off",
    description: "A debt's balance hit $0 — a manual debt asks you to confirm it, a synced one just tells you.",
    category: "Debts",
  },
  DEBT_BALANCE_RETURNED: {
    label: "Debt Balance Returned",
    description: "A debt that was paid off now carries a real balance again.",
    category: "Debts",
  },
  SAVINGS_MILESTONE: {
    label: "Savings Milestone",
    description: "A savings goal crosses 25/50/75/100%.",
    category: "Savings",
  },
  SAVINGS_WEEKLY_NUDGE: {
    label: "Weekly Savings Nudge",
    description: "A weekly reminder to keep a savings goal on pace.",
    category: "Savings",
  },
  NEW_CYCLE: {
    label: "New Budget Period",
    description: "A new calendar month's budget period has started.",
    category: "Budget Cycle",
  },
  BUDGET_PLAN_READY: {
    label: "Budget Plan Ready",
    description: "A new month's suggested budget is waiting for you to review and confirm.",
    category: "Budget Cycle",
  },
  NEW_REPORT: {
    label: "Monthly Report Ready",
    description: "Last month's report has been finalized.",
    category: "Budget Cycle",
  },
};

// Display order for the grid's section headers — matches the order
// categories are introduced in NOTIFICATION_TYPE_META above.
export const CATEGORY_ORDER: NotificationCategory[] = [
  "Buckets",
  "Needs Your Attention",
  "Debts",
  "Savings",
  "Budget Cycle",
];

export const ALL_NOTIFICATION_TYPES = Object.keys(NOTIFICATION_TYPE_META) as NotificationType[];

// No UI to act on a debt-amount review unless you're the OWNER — the
// dashboard's DebtAmountReviewCard (src/app/page.tsx) is owner-only even
// though a full-access non-owner can view /debts read-only. Same reasoning
// for ACCOUNT_SYNC_ISSUE: /settings/accounts's reconnect/re-auth actions are
// all requireOwner()-gated, so a non-owner has nothing to do about it anyway.
const OWNER_ONLY: NotificationType[] = [
  "DEBT_AMOUNT_REVIEW",
  "DEBT_BALANCE_PAID_OFF_REVIEW",
  "DEBT_BALANCE_RETURNED",
  "ACCOUNT_SYNC_ISSUE",
];

// Savings goals and /reports are both hasFullAccess-gated — a BASIC
// (buckets-only) member has no page to view either on.
const FULL_ACCESS_ONLY: NotificationType[] = [
  "SAVINGS_MILESTONE",
  "SAVINGS_WEEKLY_NUDGE",
  "NEW_REPORT",
  "BUDGET_PLAN_READY",
  // Both queues' own count functions (getReceiptsAwaitingMatchCount,
  // getActiveUnlabeledP2PTransfers) are hasFullAccess-gated on the
  // dashboard — a BASIC/kid account has no page either surfaces on.
  "RECEIPT_NEEDS_REVIEW",
  "NEEDS_LABEL_P2P",
  // Its own queue lives on /transactions, same hasFullAccess gate as the P2P
  // and receipt-review queues above.
  "NEEDS_REFUND_MATCH_REVIEW",
  // /bills is hasFullAccess-gated, same reasoning as RECEIPT_NEEDS_REVIEW.
  "BILL_AMOUNT_REVIEW",
];

// Everything else (bucket alerts, the new-cycle ping, the opt-in weekly
// bucket digest, the every-transaction bucket alert, the "needs a bucket"
// nudge) defaults on for every access level — buckets are in scope even for
// a BASIC/kid account, and NEW_CYCLE is low-noise/non-sensitive.

// The default when a user has no NotificationPreference row for this type
// yet — role-aware, not a flat "always on": an OWNER defaults to everything
// on (matches this app's original always-send-to-household behavior); other
// access levels default to what's actually visible/actionable to them.
export function defaultNotificationEnabled(
  user: { role: string; dashboardScope: string },
  type: NotificationType,
): boolean {
  if (user.role === "OWNER") return true;
  if (OWNER_ONLY.includes(type)) return false;
  if (FULL_ACCESS_ONLY.includes(type)) return hasFullAccess(user);
  return true;
}

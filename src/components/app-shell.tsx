import Image from "next/image";
import Link from "next/link";
import { hasFullAccess, canViewNetWorth } from "@/lib/access";
import { needsBankConnectionAttention } from "@/lib/bank-connection";
import { hasDebtsNeedingAttention } from "@/lib/debt-payments";
import { hasBillsNeedingAttention } from "@/lib/recurring-bills";
import { needsAiAttention } from "@/lib/ai-provider";
import { GeometricBackground } from "./geometric-background";
import { ProfileMenu } from "./profile-menu";
import { BottomNav } from "./bottom-nav";
import { DesktopSidebar } from "./desktop-sidebar";
import { ToastSuppressor } from "./toast-suppressor";

export async function AppShell({
  title,
  titleIcon,
  titleActions,
  breadcrumb,
  user,
  width = "wide",
  children,
}: {
  title: string;
  // Small glyph shown left of the page heading (e.g. a bucket's keyword-
  // resolved icon — see bucketIconComponent, src/lib/bucket-icons.tsx).
  titleIcon?: React.ReactNode;
  titleActions?: React.ReactNode;
  // Parent-page crumb rendered inline on the heading line as
  // "← Parent / Title", same font as the h1. Replaces the old standalone
  // "-mt-2 text-sm" back-link that every sub-page used to render as its
  // first child — consolidates it onto the title row instead.
  breadcrumb?: { href: string; label: string };
  user: { name?: string | null; role: string; dashboardScope: string; householdId: string; isDemo?: boolean };
  // Desktop (`lg:`+) content width. Below `lg` both are the mobile `max-w-md`.
  //   "wide" (default) → the dashboard's ~1152px @lg / ~1280px @xl frame,
  //     centered in the space right of the sidebar. The page lays its own
  //     rows out in columns via classNames. Every page gets this — nothing is
  //     left-tucked against the rail any more.
  //   "reading" → the same wide `<main>` frame (title row, demo banner and
  //     sidebar gutter all line up with every other page) but the page BODY
  //     is capped to a centered ~672px column. For compact pages with a
  //     single form/list and nothing to spread out (the small /settings/*
  //     pages, the /reports document).
  width?: "wide" | "reading";
  children: React.ReactNode;
}) {
  // The profile icon's badge means exactly "something in Settings needs a
  // human" — it must always chain: profile dot → dropdown "Settings" row dot
  // → a Settings card dot (Account Sync / AI Features) → the specific item.
  // Bills are deliberately NOT in it (2026-08-27 — a household with only
  // unconfirmed bill due dates saw a badged profile icon that led nowhere:
  // no dropdown dot, no Settings dot, since bills are only fixable on the
  // Buckets tab): they get the /buckets bottom-nav dot and nothing else.
  // needsDebts drives both the /debts tab dot AND the Settings chain (its
  // "needs setup" rows render under Account Sync too). Settings' own two
  // row-level dots (Account Sync, AI features) and every bucket/bill/debt-row
  // content-level dot are unchanged — that's the correct "bubble down" once
  // someone's actually navigated in. Bank/AI issues stay full-access-gated,
  // but debts went owner-only (2026-08-21 — /debts itself is still readable by a
  // full-access non-owner, but every one of its "needs a human" signals
  // resolves through a debt-editing action only an owner can take, so
  // there's nothing for anyone else to do about the dot). Buckets is visible
  // to everyone, so that one isn't gated at all.
  const [needsBank, needsDebts, needsBills, needsAi] = await Promise.all([
    hasFullAccess(user) ? needsBankConnectionAttention(user.householdId) : Promise.resolve(false),
    user.role === "OWNER" ? hasDebtsNeedingAttention(user.householdId) : Promise.resolve(false),
    hasBillsNeedingAttention(user.householdId),
    user.role === "OWNER" ? needsAiAttention(user.householdId) : Promise.resolve(false),
  ]);
  // What the dropdown's own "Settings" row dot bubbles down to — bank/AI
  // issues live in Settings, and so does fixing an unconfirmed/misclassified
  // debt (Settings > Account Sync renders the same per-debt "needs setup"
  // rows /debts does), so debts counts here too (2026-08-19). Bills don't —
  // there's no bill-editing surface in Settings, only on the Buckets tab —
  // so that one still only lights up the bottom-nav dot.
  const settingsNeedsAttention = needsBank || needsAi || needsDebts;
  // Profile icon badge === the Settings chain, nothing more (see comment
  // above). needsBills lights only the /buckets tab dot below.
  const needsAttention = settingsNeedsAttention;
  // The header is always the brand mark, not the current page's name — a
  // consistent top-left "logo + flow" home link on every page, the way
  // most apps anchor navigation. The page's own title (when it's not just
  // "flow" itself, i.e. every page except Home) moves down into `main`
  // as a regular heading instead, so page identity isn't lost — just no
  // longer crowding the persistent brand header.
  const pageTitle = title !== "flow" ? title : null;

  return (
    // overflow-x-clip, not -hidden: `hidden` makes this div a scroll container
    // (overflow-y computes to auto), which silently pins every `sticky`
    // descendant — the mobile header, /budget's live total and confirm bar —
    // to a box that never scrolls, so none of them ever stuck (2026-10-02).
    // `clip` trims the same horizontal overflow without that side effect.
    <div className="relative min-h-dvh overflow-x-clip">
      <GeometricBackground />

      <DesktopSidebar
        user={user}
        fullAccess={hasFullAccess(user)}
        canViewNetWorth={canViewNetWorth(user)}
        needsAttention={needsAttention}
        settingsNeedsAttention={settingsNeedsAttention}
        attention={{ "/buckets": needsBills, "/debts": needsDebts, "/settings": settingsNeedsAttention }}
      />

      <div className="relative flex min-w-0 flex-col lg:pl-64 xl:pl-72">
        <header
          className="sticky top-0 z-[var(--z-chrome)] flex items-center justify-between border-b border-blue-100 dark:border-neutral-800 bg-[var(--background)]/90 px-4 backdrop-blur lg:hidden"
          style={{ paddingTop: "max(0.75rem, env(safe-area-inset-top))", paddingBottom: "0.75rem" }}
        >
          <Link href="/" className="flex items-center gap-2">
            <Image src="/icons/flowText.png" alt="flow" width={269} height={104} className="h-7 w-auto" priority />
          </Link>
          <ProfileMenu user={user} needsAttention={needsAttention} settingsNeedsAttention={settingsNeedsAttention} />
        </header>

        <main className="relative mx-auto flex w-full flex-col gap-6 px-4 pt-3 pb-24 max-w-md lg:max-w-6xl lg:px-8 lg:py-8 lg:pb-10 xl:max-w-7xl">
          {user.isDemo && (
            <>
              <ToastSuppressor />
              <p className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-center text-xs font-medium text-amber-800 dark:border-amber-400/40 dark:bg-amber-400/10 dark:text-amber-300">
                You&rsquo;re Viewing the Read-Only Example Household — Changes Won&rsquo;t Save
              </p>
            </>
          )}
          {pageTitle && (
            // Breaks the heading row out of the `max-w-md` content column so it
            // spans the full viewport width below `lg` (same `px-4` gutter as
            // the sticky header above) — every page's title sits flush with
            // the "flow" mark and titleActions flush with the profile icon,
            // matching how the header row itself is never centered in a
            // narrower column. At `lg:`+ the same trick breaks it out of
            // `main`'s own `mx-auto` centering too (household request,
            // 2026-09-22: "wide" pages center their body content, but the
            // title row should still hug the sidebar on the left and reach
            // the true right edge, not just main's own capped/centered
            // edges) — same `calc(50% - 50vw)` idea, offset by *half* the
            // sidebar's width (`lg:pl-64`/`xl:pl-72` above): the bare
            // `calc(50% - 50vw)` breakout already lands halfway there on its
            // own (percentage margins resolve against `main`'s own centered
            // width, which cancels only half of the sidebar's offset), so
            // adding the sidebar's *full* width here overshoots back out to
            // roughly `main`'s own centered edge — indistinguishable from no
            // breakout at all (2026-09-23 bug). Rows below (`children`) stay
            // in main's centered column.
            <div className="mx-[calc(50%-50vw)] flex items-center justify-between gap-1.5 px-4 lg:mx-[calc(50%-50vw+8rem)] lg:px-8 xl:mx-[calc(50%-50vw+9rem)]">
              <div className="flex min-w-0 items-center gap-2">
                {breadcrumb && (
                  <>
                    <Link
                      href={breadcrumb.href}
                      className="-ml-1 shrink-0 whitespace-nowrap text-sm text-gray-500 hover:underline dark:text-neutral-400"
                    >
                      ← {breadcrumb.label}
                    </Link>
                    <span aria-hidden className="shrink-0 text-sm text-gray-300 dark:text-neutral-600">
                      /
                    </span>
                  </>
                )}
                {titleIcon}
                <h1 className="truncate text-xl font-bold text-blue-900 dark:text-blue-300">{pageTitle}</h1>
              </div>
              {titleActions}
            </div>
          )}
          {width === "reading" ? (
            // Compact pages: keep the full-width `<main>` frame (title row,
            // demo banner, sidebar gutter all match every other page) but cap
            // the body to a centered reading column instead of stretching a
            // lone form/list across ~1280px.
            <div className="flex w-full flex-col gap-6 lg:mx-auto lg:max-w-2xl">{children}</div>
          ) : (
            children
          )}
        </main>
      </div>

      <BottomNav
        fullAccess={hasFullAccess(user)}
        attention={{ "/buckets": needsBills, "/debts": needsDebts }}
        className="lg:hidden"
      />
    </div>
  );
}

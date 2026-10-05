"use client";

import Link from "next/link";
import { UsageSynopsis } from "@/components/usage-synopsis";

// Same collapsed-by-default convention as settings/ai/ai-usage-synopsis.tsx.
const STORAGE_KEY = "flow:settings-members:synopsis-expanded";

const FEATURES: { title: string; description: React.ReactNode }[] = [
  {
    title: "What They Can See",
    description: (
      <>
        Basic Access collapses the whole app to buckets and budget only — no bills, debts, income, or
        connected-account screens in the nav at all, not just a locked page. Partner sees everything an Owner
        does except Net Worth.
      </>
    ),
  },
  {
    title: "What They Can Change",
    description: (
      <>
        adding or editing another member, and promoting someone to Owner, is Owner-only — a Partner with full
        financial visibility still can&apos;t touch this page themselves.
      </>
    ),
  },
  {
    title: "Two-Factor Requirement",
    description: (
      <>
        Owner and Partner both require 2FA enrollment before they can log in at all (this app touches real
        linked bank and debt data); Basic Access never does.
      </>
    ),
  },
  {
    title: "Notification Defaults",
    description: (
      <>
        a member&apos;s access level sets their starting notification toggles on{" "}
        <Link href="/settings/notifications" className="underline">
          the Notifications page
        </Link>{" "}
        — full-financials-only pushes start off for Basic Access, since they wouldn&apos;t be actionable.
      </>
    ),
  },
];

export function MembersUsageSynopsis() {
  return (
    <UsageSynopsis
      storageKey={STORAGE_KEY}
      title="How Access Level Is Used"
      intro={
        <>
          Owner, Partner, and Basic Access aren&apos;t just labels — they&apos;re the one setting behind
          what a member&apos;s whole account can see and do across Flow.
        </>
      }
      features={FEATURES}
    />
  );
}

"use client";

import { UsageSynopsis } from "@/components/usage-synopsis";

// Same collapsed-by-default convention as settings/ai/ai-usage-synopsis.tsx
// and settings/household/household-usage-synopsis.tsx.
const STORAGE_KEY = "flow:settings-income:synopsis-expanded";

const FEATURES: { title: string; description: React.ReactNode }[] = [
  {
    title: "Income Total",
    description: (
      <>
        the one figure shown as your total monthly income on the Income page — computed by turning every
        recurring paycheck into a monthly-equivalent amount using whichever calculation method you pick below.
      </>
    ),
  },
  {
    title: "Bucket Allocation Summary",
    description: (
      <>
        the Buckets page&apos;s &quot;allocated vs. income&quot; summary is that same total minus every
        bucket&apos;s monthly cap — the method you pick directly shifts how much room it looks like you have
        left to allocate.
      </>
    ),
  },
  {
    title: "Savings Capacity",
    description: (
      <>
        the &quot;realistic savings capacity&quot; behind a savings goal&apos;s weekly AI coaching starts from
        this same income total, so a method change here also shifts how aggressive that coaching can
        realistically suggest being.
      </>
    ),
  },
];

export function IncomeUsageSynopsis() {
  return <UsageSynopsis storageKey={STORAGE_KEY} title="How This Is Used" features={FEATURES} />;
}

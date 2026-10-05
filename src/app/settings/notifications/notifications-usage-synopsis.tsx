"use client";

import { UsageSynopsis } from "@/components/usage-synopsis";

// Same collapsed-by-default convention as settings/ai/ai-usage-synopsis.tsx.
const STORAGE_KEY = "flow:settings-notifications:synopsis-expanded";

const FEATURES: { title: string; description: React.ReactNode }[] = [
  {
    title: "The Push Is a Copy, Not the Source",
    description: (
      <>
        every one of these triggers already shows as its own dismissible card on the dashboard or its own
        queue elsewhere (bucket warnings, needs-a-bucket, receipt review, and the rest) independent of these
        toggles — turning a push off here only stops the phone notification, it never hides the underlying
        card or queue.
      </>
    ),
  },
  {
    title: "Once Per Batch, Not Once Per Item",
    description: (
      <>
        the review-queue pushes (needs a bucket, P2P label, receipt review, refund match) re-send only once a
        newer item shows up than whatever last triggered one — clearing the whole queue and having it stay
        empty won&apos;t nag again, but one new stray transaction will.
      </>
    ),
  },
  {
    title: "Role-Aware Defaults",
    description: (
      <>
        a member&apos;s starting toggle state depends on their access level, not a flat everyone-gets-
        everything default — an Owner starts fully opted in, while a full-financials-only push (a debt
        review, say) starts off for a Basic Access member since it wouldn&apos;t be actionable for them. Any
        toggle can still be switched either way from here regardless of that starting point.
      </>
    ),
  },
];

export function NotificationsUsageSynopsis() {
  return (
    <UsageSynopsis
      storageKey={STORAGE_KEY}
      title="How Notification Preferences Are Used"
      intro={
        <>
          Each toggle below already explains what specifically triggers it — this is about how that push
          relates to the rest of Flow, not what it means.
        </>
      }
      features={FEATURES}
    />
  );
}

"use client";

import { UsageSynopsis } from "@/components/usage-synopsis";

// Same collapsed-by-default convention as settings/ai/ai-usage-synopsis.tsx.
const STORAGE_KEY = "flow:settings-email:synopsis-expanded";

const FEATURES: { title: string; description: React.ReactNode }[] = [
  {
    title: "Who a P2P Charge Really Went To",
    description: (
      <>
        an opaque bank line like &quot;Transfer to Venmo&quot; gets the real payee&apos;s name attached the
        moment a matching receipt shows up, so the P2P review queue and the transaction list read
        &quot;Venmo · Dana Smith&quot; instead of just &quot;Venmo.&quot;
      </>
    ),
  },
  {
    title: "Refund Matching",
    description: (
      <>
        a return confirmation email is what lets a credit get linked back to the specific purchase it&apos;s
        undoing, instead of sitting in the Possible Refunds queue waiting for a household member to pick it
        by hand.
      </>
    ),
  },
  {
    title: "BNPL Plan Setup",
    description: (
      <>
        an order confirmation&apos;s line items and total are what a newly-tracked Affirm/Klarna/Afterpay
        plan shows as its own itemized receipt on the debt&apos;s card — without one, the plan still tracks
        fine, it just has no purchase detail attached.
      </>
    ),
  },
  {
    title: "Charge Mismatch Flags",
    description: (
      <>
        when a receipt&apos;s stated total doesn&apos;t match what actually posted (a tip added after
        checkout, a partial shipment), the transaction row shows both figures side by side rather than
        silently trusting one.
      </>
    ),
  },
];

export function EmailUsageSynopsis() {
  return (
    <UsageSynopsis
      storageKey={STORAGE_KEY}
      title="How Email Receipts Are Used"
      intro={
        <>
          A receipt never creates a transaction or moves money on its own — it only ever enriches a real
          bank transaction that already synced in from SimpleFIN, filling in detail the bank feed alone
          can&apos;t provide. Only messages that look like a receipt are ever sent to your household&apos;s
          AI provider, and Flow only ever reads your mail — it never sends, moves, or deletes anything.
        </>
      }
      features={FEATURES}
    />
  );
}

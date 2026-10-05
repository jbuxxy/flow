"use client";

import type { AlertMember } from "./bucket-alert-recipients";
import { useState } from "react";
import { Settings } from "lucide-react";
import { Modal } from "@/components/modal";
import { BucketSettingsForm, type BucketAlertOverridesByUser } from "./bucket-settings-form";
import type { CategoryOption } from "@/app/bills/category-picker";

type TrackingMode = "SPEND" | "RECURRING" | "MIXED";

export type AmountRoutingRule = {
  id: string;
  merchant: string;
  amountMinCents: number;
  amountMaxCents: number;
};

export function BucketTitleSettings({
  bucket,
  categories,
  amountRoutingRules,
  routingBuckets,
  isOwner,
  alertsLocked,
  currentUserId,
  members,
  alertOverrides,
}: {
  bucket: {
    id: string;
    name: string;
    monthlyCapCents: number;
    warningThresholdPct: number;
    paceAlertEnabled: boolean;
    weeklyReportEnabled: boolean;
    transactionAlertEnabled: boolean;
    trackingMode: TrackingMode;
    excludedFromAllocation: boolean;
    aiInstructions: string | null;
  };
  categories: CategoryOption[];
  amountRoutingRules: AmountRoutingRule[];
  routingBuckets: { id: string; name: string }[];
  isOwner: boolean;
  alertsLocked: boolean;
  currentUserId: string;
  members: AlertMember[];
  alertOverrides: BucketAlertOverridesByUser;
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Bucket Settings"
        title="Bucket Settings"
        className="-mr-1 text-neutral-400 hover:text-neutral-700 dark:text-neutral-500 dark:hover:text-neutral-300"
      >
        <Settings size={18} />
      </button>

      <Modal open={open} onClose={() => setOpen(false)} title="Bucket Settings">
        <BucketSettingsForm
          bucket={bucket}
          categories={categories}
          amountRoutingRules={amountRoutingRules}
          routingBuckets={routingBuckets}
          isOwner={isOwner}
          alertsLocked={alertsLocked}
          currentUserId={currentUserId}
          members={members}
          alertOverrides={alertOverrides}
          onSaved={() => setOpen(false)}
        />
      </Modal>
    </>
  );
}

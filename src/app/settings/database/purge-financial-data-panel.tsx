"use client";

import { DestructiveConfirmPanel } from "@/components/destructive-confirm-panel";
import { purgeFinancialData, type PurgeFinancialDataState } from "./actions";

const initialState: PurgeFinancialDataState = {};

export function PurgeFinancialDataPanel() {
  return (
    <DestructiveConfirmPanel
      title="Wipe Financial Data"
      description="Permanently deletes every bucket, transaction, debt, savings goal, connected account, and report — but keeps your login, 2FA, and AI provider config. Lets you re-run the setup wizard from a clean slate. This can't be undone."
      triggerLabel="Wipe Financial Data"
      confirmFieldName="confirmText"
      confirmFieldLabel={
        <>
          Type <span className="font-semibold">PURGE</span> to Confirm
        </>
      }
      submitLabel="Permanently Wipe"
      pendingLabel="Wiping…"
      successToast="Financial Data Purged"
      action={purgeFinancialData}
      initialState={initialState}
    />
  );
}

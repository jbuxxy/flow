"use client";

import { DestructiveConfirmPanel } from "@/components/destructive-confirm-panel";
import { deleteHousehold, type DeleteHouseholdState } from "./actions";

const initialState: DeleteHouseholdState = {};

export function DangerZone({ householdName }: { householdName: string }) {
  return (
    <DestructiveConfirmPanel
      title="Danger Zone"
      description="Permanently deletes the household, every member, and all buckets, transactions, debts, and savings data. This can't be undone."
      triggerLabel="Delete Household"
      confirmFieldName="confirmName"
      confirmFieldLabel={
        <>
          Type <span className="font-semibold">{householdName}</span> to Confirm
        </>
      }
      submitLabel="Permanently Delete"
      pendingLabel="Deleting…"
      successToast="Household Deleted"
      action={deleteHousehold}
      initialState={initialState}
    />
  );
}

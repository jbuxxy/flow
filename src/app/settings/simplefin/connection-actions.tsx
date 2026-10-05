"use client";

import { useState, useTransition } from "react";
import { RefreshCw, ExternalLink } from "lucide-react";
import { syncNow, disconnectSimpleFin } from "./actions";
import { Modal } from "@/components/modal";
import { showToast } from "@/lib/toast";

export function ConnectionActions() {
  const [syncPending, startSync] = useTransition();
  const [disconnectPending, startDisconnect] = useTransition();
  const [confirmOpen, setConfirmOpen] = useState(false);

  return (
    <div className="flex items-center gap-2 shrink-0">
      <button
        onClick={() =>
          startSync(async () => {
            try {
              await syncNow();
              showToast("Sync Complete");
            } catch {
              showToast("Sync Failed", "error");
            }
          })
        }
        disabled={syncPending}
        aria-label={syncPending ? "Syncing" : "Sync Now"}
        title={syncPending ? "Syncing…" : "Sync Now"}
        className="rounded-lg bg-blue-900 dark:bg-blue-700 p-2 text-white disabled:opacity-50"
      >
        <RefreshCw size={15} className={syncPending ? "animate-spin" : undefined} />
      </button>
      <a
        href="https://bridge.simplefin.org"
        target="_blank"
        rel="noopener noreferrer"
        aria-label="Manage on SimpleFIN"
        title="Manage on SimpleFIN"
        className="rounded-lg border border-neutral-300 dark:border-neutral-700 p-2"
      >
        <ExternalLink size={15} />
      </a>
      {/* Text, not icon-only — destructive settings actions keep a label
          (see WORKING_ON.md's UI conventions). Gated behind a real Modal
          confirmation instead of a plain confirm(). */}
      <button
        onClick={() => setConfirmOpen(true)}
        disabled={disconnectPending}
        className="rounded-lg border border-neutral-300 dark:border-neutral-700 px-2.5 py-2 text-sm font-medium text-red-600 dark:text-red-400 disabled:opacity-50"
      >
        {disconnectPending ? "Disconnecting…" : "Disconnect"}
      </button>

      <Modal open={confirmOpen} onClose={() => setConfirmOpen(false)} title="Disconnect SimpleFIN?">
        <p className="text-sm text-gray-600 dark:text-neutral-400">
          Synced accounts and their transaction history will be removed. Manual data (BNPL, cards, loans
          you&apos;ve entered by hand) is untouched.
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <button
            onClick={() => setConfirmOpen(false)}
            className="rounded-lg border border-neutral-300 dark:border-neutral-700 px-3 py-2 text-sm font-medium"
          >
            Cancel
          </button>
          <button
            onClick={() => {
              setConfirmOpen(false);
              startDisconnect(async () => {
                try {
                  await disconnectSimpleFin();
                  showToast("SimpleFIN Disconnected");
                } catch {
                  showToast("Something Went Wrong", "error");
                }
              });
            }}
            className="rounded-lg bg-red-600 px-3 py-2 text-sm font-medium text-white"
          >
            Yes, Disconnect
          </button>
        </div>
      </Modal>
    </div>
  );
}

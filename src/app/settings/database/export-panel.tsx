"use client";

import { useTransition } from "react";
import { currentDateKey } from "@/lib/period";
import { exportHouseholdData } from "./actions";
import { showToast } from "@/lib/toast";

export function ExportPanel() {
  const [pending, startTransition] = useTransition();

  function download() {
    startTransition(async () => {
      try {
        const json = await exportHouseholdData();
        const blob = new Blob([json], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `flow-backup-${currentDateKey()}.json`;
        a.click();
        URL.revokeObjectURL(url);
        showToast("Backup Downloaded");
      } catch {
        showToast("Export Failed", "error");
      }
    });
  }

  return (
    <div className="rounded-2xl border border-blue-100 dark:border-neutral-800 p-4">
      <h2 className="text-sm font-semibold text-emerald-700 dark:text-emerald-400">Export Data</h2>
      <p className="mt-1 text-xs text-gray-500 dark:text-neutral-400">
        Downloads a JSON backup of every bucket, transaction, debt, and other financial record — not your login,
        2FA, or bank/AI credentials.
      </p>
      <button
        type="button"
        onClick={download}
        disabled={pending}
        className="mt-3 rounded-lg border border-neutral-300 dark:border-neutral-700 px-4 py-2.5 text-sm font-medium disabled:opacity-50"
      >
        {pending ? "Preparing…" : "Download Backup"}
      </button>
    </div>
  );
}

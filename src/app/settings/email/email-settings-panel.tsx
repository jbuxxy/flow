"use client";

import { useActionState, useEffect, useState, useTransition } from "react";
import { useActionToast } from "@/lib/use-action-toast";
import { showToast } from "@/lib/toast";
import { AlertTriangle, Mail, Pencil, Plus, RefreshCw, RotateCw } from "lucide-react";
import {
  connectEmail,
  disconnectEmail,
  retestEmailConnection,
  scanMyEmailNow,
  type EmailSettingsState,
  type ReceiptScanStatus,
} from "./actions";
import type { EmailConnectionStatus } from "@prisma/client";

async function fetchScanStatus(): Promise<ReceiptScanStatus | null> {
  try {
    const res = await fetch("/api/settings/email/scan-status", { cache: "no-store" });
    if (!res.ok) return null;
    return (await res.json()) as ReceiptScanStatus;
  } catch {
    return null;
  }
}

const initialState: EmailSettingsState = {};

const GMAIL_DEFAULTS = { host: "imap.gmail.com", port: "993" };

// `connectionId` is null for a brand-new inbox, or the id of an existing
// connection whose credential this replaces in place (its receipt history
// and sync cursors are untouched either way — only ACTIVE/lastError/the
// stored password change on a replace).
export function EmailConnectForm({
  connectionId = null,
  onCancel,
  onSaved,
  hideHeading = false,
}: {
  connectionId?: string | null;
  onCancel?: () => void;
  onSaved?: () => void;
  // The onboarding wizard already renders its own "Connect Your Inbox —
  // Optional" heading around this form (onboarding-wizard.tsx) — showing
  // this one too reads as "Connect Your Inbox" nested inside "Connect Your
  // Inbox" (household report, 2026-09-11). Every other caller (Settings)
  // drops this straight into a plain page with no heading of its own, so
  // the default stays visible there.
  hideHeading?: boolean;
}) {
  const [state, formAction, pending] = useActionState(connectEmail.bind(null, connectionId), initialState);
  const [host, setHost] = useState(GMAIL_DEFAULTS.host);
  const [port, setPort] = useState(GMAIL_DEFAULTS.port);

  useActionToast(pending, state, { success: connectionId ? "Connection Updated" : "Email Connected", onSuccess: () => onSaved?.() });

  return (
    <form
      action={formAction}
      className="flex flex-col gap-3 rounded-xl border border-blue-100 dark:border-neutral-800 p-4"
    >
      {!hideHeading && (
        <h2 className="text-sm font-semibold text-emerald-700 dark:text-emerald-400">
          {connectionId ? "Replace App Password" : "Connect Another Inbox"}
        </h2>
      )}
      <p className="text-xs text-gray-500 dark:text-neutral-400">
        Gmail needs an{" "}
        <a
          href="https://myaccount.google.com/apppasswords"
          target="_blank"
          rel="noopener noreferrer"
          className="font-medium text-blue-900 underline dark:text-blue-300"
        >
          App Password
        </a>{" "}
        (turn on 2-Step Verification first) — not your normal account
        password. Other providers use an app-specific password the same way.
      </p>

      <div className="grid grid-cols-[1fr_5rem] gap-2">
        <div>
          <label className="mb-1 block text-xs text-gray-500 dark:text-neutral-400">Mail Server (IMAP)</label>
          <input
            name="imapHost"
            value={host}
            onChange={(e) => setHost(e.target.value)}
            required
            autoComplete="off"
            className="w-full rounded-lg border border-neutral-300 dark:border-neutral-700 px-3 py-2.5 text-sm focus:border-blue-900 focus:outline-none"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs text-gray-500 dark:text-neutral-400">Port</label>
          <input
            name="imapPort"
            value={port}
            onChange={(e) => setPort(e.target.value)}
            inputMode="numeric"
            required
            className="w-full rounded-lg border border-neutral-300 dark:border-neutral-700 px-3 py-2.5 text-sm focus:border-blue-900 focus:outline-none"
          />
        </div>
      </div>

      <div>
        <label className="mb-1 block text-xs text-gray-500 dark:text-neutral-400">Email Address</label>
        <input
          name="imapUser"
          type="email"
          autoComplete="off"
          placeholder="you@gmail.com"
          required
          className="w-full rounded-lg border border-neutral-300 dark:border-neutral-700 px-3 py-2.5 text-sm focus:border-blue-900 focus:outline-none"
        />
      </div>

      <div>
        <label className="mb-1 block text-xs text-gray-500 dark:text-neutral-400">App Password</label>
        <input
          name="imapPassword"
          type="password"
          autoComplete="off"
          placeholder="Paste the app password"
          required
          className="w-full rounded-lg border border-neutral-300 dark:border-neutral-700 px-3 py-2.5 text-sm focus:border-blue-900 focus:outline-none"
        />
      </div>

      <label className="flex items-start gap-2 text-xs text-gray-600 dark:text-neutral-400">
        <input type="checkbox" name="consent" className="mt-0.5 shrink-0" required />
        <span>
          I&apos;m okay with receipt- or bill-amount-looking emails from my
          inbox being sent to my household&apos;s configured AI provider so
          Flow can read them.
        </span>
      </label>

      {state.error && (
        <p className="text-sm text-red-600 dark:text-red-400" role="alert">
          {state.error}
        </p>
      )}

      <div className="flex items-center justify-end gap-3">
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            className="rounded-lg border border-neutral-300 px-4 py-2.5 text-sm font-medium dark:border-neutral-700"
          >
            Cancel
          </button>
        )}
        <button
          type="submit"
          disabled={pending}
          className="rounded-lg bg-blue-900 px-4 py-2.5 text-sm font-medium text-white disabled:opacity-50 dark:bg-blue-700"
        >
          {pending ? "Connecting…" : connectionId ? "Save" : "Connect"}
        </button>
      </div>
    </form>
  );
}

type EmailConnectionRow = {
  id: string;
  imapUser: string;
  status: EmailConnectionStatus;
  lastError: string | null;
};

// One connected inbox's own status/controls — a member can have several
// (household request, 2026-09-11: e.g. a personal + a work inbox), each
// independently connected/replaced/disconnected/retested.
function ConnectionRow({ connection }: { connection: EmailConnectionRow }) {
  const [replacing, setReplacing] = useState(false);
  const [disconnectPending, startDisconnect] = useTransition();
  const [retestPending, startRetest] = useTransition();

  if (replacing) {
    return (
      <EmailConnectForm
        connectionId={connection.id}
        onCancel={() => setReplacing(false)}
        onSaved={() => setReplacing(false)}
      />
    );
  }

  return (
    <div className="rounded-xl border border-blue-100 p-4 dark:border-neutral-800">
      <div className="flex items-center justify-between gap-3">
        <p className="flex min-w-0 items-center gap-1.5 text-sm text-neutral-900 dark:text-neutral-100">
          <Mail size={14} className="shrink-0 text-blue-900 dark:text-blue-400" />
          <span className="min-w-0 truncate font-medium">{connection.imapUser}</span>
          {connection.status === "ERROR" ? (
            <span className="shrink-0 text-xs font-medium text-red-600 dark:text-red-400">Error</span>
          ) : (
            <span
              role="img"
              aria-label="Connected"
              title="Connected"
              className="h-2 w-2 shrink-0 rounded-full bg-emerald-500 shadow-[0_0_6px_var(--color-emerald-500)]"
            />
          )}
        </p>
        <div className="flex shrink-0 items-center gap-2">
          {connection.status === "ERROR" && (
            <button
              onClick={() =>
                startRetest(async () => {
                  try {
                    await retestEmailConnection(connection.id);
                    showToast("Connection Retested");
                  } catch {
                    showToast("Retest Failed", "error");
                  }
                })
              }
              disabled={retestPending}
              aria-label="Retest Connection"
              title="Retest Connection"
              className="rounded-lg border border-neutral-300 p-2 text-neutral-500 disabled:opacity-50 dark:border-neutral-700 dark:text-neutral-400"
            >
              <RotateCw size={15} className={retestPending ? "animate-spin" : undefined} />
            </button>
          )}
          <button
            onClick={() => setReplacing(true)}
            aria-label="Replace App Password"
            title="Replace App Password"
            className="rounded-lg border border-neutral-300 p-2 text-neutral-500 dark:border-neutral-700 dark:text-neutral-400"
          >
            <Pencil size={15} />
          </button>
          {/* Text, not icon-only — destructive settings actions keep a label
              (WORKING_ON.md UI conventions). */}
          <button
            onClick={() => {
              if (
                !confirm(
                  "Disconnect this inbox? Flow will stop reading new receipts from it. Item detail already attached to your transactions stays.",
                )
              )
                return;
              startDisconnect(async () => {
                try {
                  await disconnectEmail(connection.id);
                  showToast("Inbox Disconnected");
                } catch {
                  showToast("Something Went Wrong", "error");
                }
              });
            }}
            disabled={disconnectPending}
            className="rounded-lg border border-neutral-300 px-2.5 py-2 text-sm font-medium text-red-600 disabled:opacity-50 dark:border-neutral-700 dark:text-red-400"
          >
            {disconnectPending ? "Disconnecting…" : "Disconnect"}
          </button>
        </div>
      </div>

      {connection.status === "ERROR" && connection.lastError && (
        <div className="mt-3 flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-2.5 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-400">
          <AlertTriangle size={15} className="mt-0.5 shrink-0" />
          <span>{connection.lastError}</span>
        </div>
      )}
    </div>
  );
}

export function EmailSettingsPanel({
  connections,
  initialStatus,
}: {
  connections: EmailConnectionRow[];
  initialStatus: ReceiptScanStatus;
}) {
  const [addingAnother, setAddingAnother] = useState(false);

  // Live counts. `initialStatus` is the server render; `polled` is whatever
  // the poller last read (always at least as fresh). Render whichever we
  // have. Aggregated across every one of the member's connections — one
  // "receipts read / awaiting" summary, not per-connection, matching how
  // scanMyEmailNow already scans all of them in one go.
  const [polled, setPolled] = useState<ReceiptScanStatus | null>(null);
  const status = polled ?? initialStatus;

  // scanMyEmailNow is fire-and-forget on the server; the scan itself runs for
  // minutes. Poll until the server reports it done (or resume polling if the
  // page loaded mid-scan).
  const [watching, setWatching] = useState(initialStatus.scanning);
  const scanning = watching || status.scanning;

  useEffect(() => {
    if (!watching) return;
    let sawIdle = 0;
    const tick = async () => {
      const s = await fetchScanStatus();
      if (!s) return;
      setPolled(s);
      // Two consecutive idle reads before stopping — the kickoff sets the
      // server flag synchronously, so one stray early idle shouldn't end it.
      if (s.scanning) sawIdle = 0;
      else if (++sawIdle >= 2) setWatching(false);
    };
    tick();
    const id = setInterval(tick, 2500);
    return () => clearInterval(id);
  }, [watching]);

  const onScan = () => {
    setWatching(true);
    void scanMyEmailNow();
    showToast("Email Scan Started");
  };

  if (connections.length === 0) {
    return <EmailConnectForm />;
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-base font-semibold text-emerald-700 dark:text-emerald-400">Inbox Status</h3>
        <button
          onClick={onScan}
          disabled={scanning}
          aria-label={scanning ? "Scanning" : "Scan My Email Now"}
          title={scanning ? "Scanning…" : "Scan My Email Now"}
          className="rounded-lg bg-blue-900 p-2 text-white disabled:opacity-50 dark:bg-blue-700"
        >
          <RefreshCw size={15} className={scanning ? "animate-spin" : undefined} />
        </button>
      </div>

      {connections.map((c) => (
        <ConnectionRow key={c.id} connection={c} />
      ))}

      <p className="text-xs text-gray-500 dark:text-neutral-400">
        {scanning ? (
          <span className="text-blue-900 dark:text-blue-300">Checking your inbox…</span>
        ) : status.lastPolledAt ? (
          `Last checked ${new Date(status.lastPolledAt).toLocaleString()}`
        ) : (
          "Not checked yet — Flow will scan the last 90 days on its next sync."
        )}
      </p>
      <p className="-mt-2 text-xs text-gray-500 dark:text-neutral-400">
        <span className={scanning ? "font-medium text-emerald-700 dark:text-emerald-400" : undefined}>
          {status.parsedCount} receipt{status.parsedCount === 1 ? "" : "s"} read
        </span>
        {status.awaitingCount > 0 ? ` · ${status.awaitingCount} awaiting a matching charge` : ""}
      </p>

      {addingAnother ? (
        <EmailConnectForm onCancel={() => setAddingAnother(false)} onSaved={() => setAddingAnother(false)} />
      ) : (
        <button
          type="button"
          onClick={() => setAddingAnother(true)}
          className="flex items-center justify-center gap-1.5 rounded-lg border border-dashed border-neutral-300 px-3 py-2 text-sm font-medium text-blue-900 dark:border-neutral-700 dark:text-blue-300"
        >
          <Plus size={15} />
          Connect Another Inbox
        </button>
      )}
    </div>
  );
}

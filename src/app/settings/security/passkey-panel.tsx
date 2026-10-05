"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ScanFace, Trash2, Pencil, Check, X } from "lucide-react";
import { showToast } from "@/lib/toast";
import { registerPasskey } from "@/lib/webauthn-client";
import { removePasskey, renamePasskey } from "./actions";

type Credential = {
  id: string;
  nickname: string;
  addedLabel: string;
  lastUsedLabel: string | null;
};

// Renders straight off the server-fetched prop rather than mirroring it into
// local state — router.refresh() after each mutation is what keeps this in
// sync (a real DB id is needed for a freshly-added row's own rename/remove
// to target the right one, which only exists once page.tsx re-queries it).
export function PasskeyPanel({ initialCredentials }: { initialCredentials: Credential[] }) {
  const router = useRouter();
  const [addPending, startAddTransition] = useTransition();
  const [addError, setAddError] = useState<string | null>(null);

  function onAdd() {
    setAddError(null);
    startAddTransition(async () => {
      const result = await registerPasskey();
      if (!result.ok) {
        if (!result.cancelled) setAddError(result.error);
        return;
      }
      showToast("Passkey Added");
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="rounded-2xl border border-blue-100 dark:border-neutral-800 p-4">
        <h2 className="text-sm font-semibold text-emerald-700 dark:text-emerald-400">Face ID / Touch ID / Windows Hello</h2>
        <p className="mt-1 text-xs text-gray-500 dark:text-neutral-400">
          Skip your password and authenticator code entirely — sign in with just your device&apos;s
          biometrics. Add one per device/browser you use (a passkey doesn&apos;t follow you between, say,
          Safari and Chrome on the same computer).
        </p>

        {initialCredentials.length > 0 && (
          <ul className="mt-3 flex flex-col gap-2">
            {initialCredentials.map((c) => (
              <PasskeyRow key={c.id} credential={c} />
            ))}
          </ul>
        )}

        {addError && (
          <p className="mt-3 text-sm text-red-600 dark:text-red-400" role="alert">
            {addError}
          </p>
        )}

        <div className="mt-4 flex justify-end">
          <button
            type="button"
            onClick={onAdd}
            disabled={addPending}
            className="flex items-center gap-2 rounded-lg bg-blue-900 dark:bg-blue-700 px-4 py-2.5 text-sm font-medium text-white disabled:opacity-50"
          >
            <ScanFace size={16} />
            {addPending ? "Setting Up…" : "Add a Passkey for This Device"}
          </button>
        </div>
      </div>
    </div>
  );
}

function PasskeyRow({ credential }: { credential: Credential }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [editing, setEditing] = useState(false);
  const [nickname, setNickname] = useState(credential.nickname);
  const [displayName, setDisplayName] = useState(credential.nickname);
  const [removed, setRemoved] = useState(false);

  function onSave() {
    const value = nickname.trim();
    if (!value || value === displayName) {
      setEditing(false);
      setNickname(displayName);
      return;
    }
    startTransition(async () => {
      const result = await renamePasskey(credential.id, value);
      if (result.ok) {
        setDisplayName(value);
        setEditing(false);
        showToast("Passkey Renamed");
        router.refresh();
      } else {
        showToast(result.error, "error");
      }
    });
  }

  function onRemove() {
    if (!confirm(`Remove "${displayName}"? You'll need your authenticator code to sign in from that device next time.`))
      return;
    startTransition(async () => {
      const result = await removePasskey(credential.id);
      if (result.ok) {
        setRemoved(true); // instant feedback — router.refresh() below is the durable sync
        showToast("Passkey Removed");
        router.refresh();
      } else {
        showToast(result.error, "error");
      }
    });
  }

  if (removed) return null;

  return (
    <li className="flex items-center gap-2 rounded-lg border border-neutral-200 dark:border-neutral-800 px-3 py-2 text-sm">
      <ScanFace size={16} className="shrink-0 text-blue-900 dark:text-blue-300" />
      <div className="min-w-0 flex-1">
        {editing ? (
          <input
            autoFocus
            value={nickname}
            onChange={(e) => setNickname(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") onSave();
              if (e.key === "Escape") {
                setNickname(displayName);
                setEditing(false);
              }
            }}
            maxLength={60}
            className="w-full rounded border border-blue-900/30 dark:border-blue-300/30 bg-[var(--background)] px-2 py-1 text-sm focus:outline-none"
          />
        ) : (
          <>
            <p className="truncate font-medium text-neutral-900 dark:text-neutral-100">{displayName}</p>
            <p className="text-xs text-gray-500 dark:text-neutral-400">
              Added {credential.addedLabel}
              {credential.lastUsedLabel ? ` · Last Used ${credential.lastUsedLabel}` : ""}
            </p>
          </>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {editing ? (
          <>
            <button onClick={onSave} disabled={pending} aria-label="Save Name" className="p-1 text-emerald-700 dark:text-emerald-400 disabled:opacity-50">
              <Check size={16} />
            </button>
            <button
              onClick={() => {
                setNickname(displayName);
                setEditing(false);
              }}
              aria-label="Cancel"
              className="p-1 text-gray-400 dark:text-neutral-500"
            >
              <X size={16} />
            </button>
          </>
        ) : (
          <>
            <button onClick={() => setEditing(true)} aria-label="Rename" className="p-1 text-gray-400 dark:text-neutral-500">
              <Pencil size={14} />
            </button>
            <button onClick={onRemove} disabled={pending} aria-label="Remove Passkey" className="p-1 text-red-600 dark:text-red-400 disabled:opacity-50">
              <Trash2 size={16} />
            </button>
          </>
        )}
      </div>
    </li>
  );
}

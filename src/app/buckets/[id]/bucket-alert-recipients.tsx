"use client";

import { useState, useTransition } from "react";
import { setBucketAlertOverride, type BucketAlertOverrideChoice, type BucketAlertOverrideType } from "./actions";
import { showToast } from "@/lib/toast";
import { LockableSwitch } from "@/components/lockable-switch";

// A household member as this panel needs them: `personal` is their own answer
// for each bucket alert type when nothing is locked here — their saved
// NotificationPreference (or its role default), false with their master
// switch off. Built in buckets/[id]/page.tsx.
export type AlertMember = {
  id: string;
  name: string;
  personal: Record<BucketAlertOverrideType, boolean>;
};

// Owner-only, rendered right under one specific alert-type checkbox in
// Bucket Settings (bucket-settings-form.tsx) — decides which household
// members receive THIS bucket's THIS alert type, independent of the other
// two (a lock on Weekly Digest says nothing about Pace or Every
// Transaction). One hold-to-lock switch per member (household request,
// 2026-10-03 — replacing the Personal/Always/Never segmented picker, same
// LockableSwitch as the notifications master):
//   - unlocked (DEFAULT): the switch shows the member's own setting and
//     tapping just stages a position; nothing is saved until it's locked.
//   - hold: locks it where it sits — on = ALWAYS, off = NEVER — overriding
//     the member's own preference for this one bucket+type in either
//     direction (household request, 2026-09-12).
//   - hold a locked switch: unlocks back to DEFAULT.
// See sendPushToBucketForType (push.ts) for the send-time logic this
// configures, and LockedAlertNote (bucket-settings-form.tsx) for a locked
// member's own view.
export function BucketAlertRecipients({
  bucketId,
  type,
  members,
  overrides,
}: {
  bucketId: string;
  type: BucketAlertOverrideType;
  members: AlertMember[];
  // userId -> current override for this specific type; a member with no
  // entry is DEFAULT.
  overrides: Record<string, BucketAlertOverrideChoice>;
}) {
  const [choiceByUser, setChoiceByUser] = useState<Record<string, BucketAlertOverrideChoice>>(() => {
    const initial: Record<string, BucketAlertOverrideChoice> = {};
    for (const m of members) initial[m.id] = overrides[m.id] ?? "DEFAULT";
    return initial;
  });
  // Unsaved positions staged by a tap on an unlocked switch.
  const [staged, setStaged] = useState<Record<string, boolean>>({});
  const [pendingUserId, setPendingUserId] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function save(userId: string, choice: BucketAlertOverrideChoice, toast: string) {
    const prev = choiceByUser[userId];
    setChoiceByUser((s) => ({ ...s, [userId]: choice }));
    setStaged((s) => {
      const next = { ...s };
      delete next[userId];
      return next;
    });
    setPendingUserId(userId);
    startTransition(async () => {
      try {
        await setBucketAlertOverride(bucketId, userId, type, choice);
        showToast(toast);
      } catch {
        setChoiceByUser((s) => ({ ...s, [userId]: prev }));
        showToast("Couldn’t Save", "error");
      }
      setPendingUserId(null);
    });
  }

  if (members.length === 0) return null;

  return (
    <ul className="ml-6 flex flex-col gap-2 border-l border-neutral-200 dark:border-neutral-800 pl-3">
      {members.map((m) => {
        const choice = choiceByUser[m.id];
        const locked = choice !== "DEFAULT";
        const position = locked ? choice === "ALWAYS" : (staged[m.id] ?? m.personal[type]);
        const stagedDiffers = !locked && staged[m.id] !== undefined && staged[m.id] !== m.personal[type];
        return (
          <li key={m.id} className="flex items-center justify-between gap-3">
            <span className="min-w-0">
              <span className="block truncate text-xs text-neutral-700 dark:text-neutral-300">{m.name}</span>
              <span className="block text-[11px] text-gray-500 dark:text-neutral-400">
                {locked
                  ? `Locked ${position ? "on" : "off"} for this bucket`
                  : stagedDiffers
                    ? "Hold to lock this choice"
                    : "Their own setting"}
              </span>
            </span>
            <LockableSwitch
              checked={position}
              locked={locked}
              onToggle={() => setStaged((s) => ({ ...s, [m.id]: !position }))}
              onLockChange={(lock) =>
                lock
                  ? save(m.id, position ? "ALWAYS" : "NEVER", `Locked ${position ? "On" : "Off"}`)
                  : save(m.id, "DEFAULT", "Unlocked")
              }
              onLockedTap={() => showToast("Hold To Unlock")}
              disabled={pending && pendingUserId === m.id}
              ariaLabel={`${m.name} — this bucket's alert`}
            />
          </li>
        );
      })}
    </ul>
  );
}

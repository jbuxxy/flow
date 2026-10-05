"use client";

import { useState, useTransition } from "react";
import { ChevronDown } from "lucide-react";
import type { NotificationType } from "@prisma/client";
import { updateNotificationPreference, setNotificationsEnabled, setNotificationsLocked } from "./actions";
import { LockableSwitch } from "@/components/lockable-switch";
import { showToast } from "@/lib/toast";
import { Switch } from "@/components/switch";
import { useStoredBoolean } from "@/lib/use-stored-boolean";
import {
  ALL_NOTIFICATION_TYPES,
  CATEGORY_ORDER,
  NOTIFICATION_TYPE_META,
  defaultNotificationEnabled,
} from "@/lib/notification-preferences";

type Member = {
  id: string;
  name: string;
  email: string;
  role: "OWNER" | "PARENT" | "CHILD";
  dashboardScope: "FULL" | "BUCKETS_ONLY";
  notificationsEnabled: boolean;
  notificationsLocked: boolean;
};

export function MemberNotificationPrefs({
  member,
  preferences,
  canEdit,
  canLock,
  showName,
  // Only meaningful alongside showName — a household with a single member
  // has nothing to fold away, so its card stays a plain (non-interactive)
  // header instead of growing a button/chevron for no reason.
  collapsible,
}: {
  member: Member;
  preferences: Record<string, boolean>;
  canEdit: boolean;
  canLock: boolean;
  showName: boolean;
  collapsible: boolean;
}) {
  const [state, setState] = useState<Record<NotificationType, boolean>>(() => {
    const initial = {} as Record<NotificationType, boolean>;
    for (const type of ALL_NOTIFICATION_TYPES) {
      initial[type] = preferences[type] ?? defaultNotificationEnabled(member, type);
    }
    return initial;
  });
  const [pendingType, setPendingType] = useState<NotificationType | null>(null);
  const [pending, startTransition] = useTransition();
  const [expanded, setExpanded] = useStoredBoolean(`flow-notif-prefs-expanded:${member.id}`, true);
  const open = !collapsible || expanded;
  const [master, setMaster] = useState(member.notificationsEnabled);
  const [locked, setLocked] = useState(member.notificationsLocked);
  const [masterPending, startMaster] = useTransition();
  // Locked + not the owner = this member's own view of an owner's lock.
  const masterEditable = canEdit && (!locked || canLock);

  function toggleMaster() {
    if (!masterEditable) return;
    const next = !master;
    setMaster(next);
    startMaster(async () => {
      const result = await setNotificationsEnabled(member.id, next);
      if (result.error) {
        setMaster(!next);
        showToast(result.error, "error");
      } else {
        showToast(next ? "Notifications On" : "Notifications Off");
      }
    });
  }

  function changeLock(next: boolean) {
    setLocked(next);
    startMaster(async () => {
      const result = await setNotificationsLocked(member.id, next);
      if (result.error) {
        setLocked(!next);
        showToast(result.error, "error");
      } else {
        showToast(next ? `Locked ${master ? "On" : "Off"}` : "Unlocked");
      }
    });
  }

  // The account-level master switch (User.notificationsEnabled) — sits in
  // the card header so it reads as "everything below."
  const masterSwitch = (
    <LockableSwitch
      checked={master}
      locked={locked}
      onToggle={toggleMaster}
      onLockChange={canLock ? changeLock : undefined}
      onLockedTap={canLock ? () => showToast("Hold To Unlock") : undefined}
      disabled={!canEdit || masterPending}
      ariaLabel={`All Notifications for ${member.name}`}
    />
  );

  function toggle(type: NotificationType) {
    if (!masterEditable) return;
    const next = !state[type];
    setState((prev) => ({ ...prev, [type]: next }));
    setPendingType(type);
    startTransition(async () => {
      const result = await updateNotificationPreference(member.id, type, next);
      if (result.error) {
        // Revert on failure — the toggle isn't optimistic-safe if the server rejects it.
        setState((prev) => ({ ...prev, [type]: !next }));
        showToast(result.error, "error");
      } else {
        showToast("Notification Preference Saved");
      }
      setPendingType(null);
    });
  }

  const header = (
    <>
      {member.name}
      {!canEdit && <span className="ml-2 text-xs font-normal text-gray-400 dark:text-neutral-500">View Only</span>}
    </>
  );

  return (
    <li className="rounded-xl border border-blue-100 dark:border-neutral-800 p-4">
      <div className="flex items-center gap-3">
        {showName ? (
          collapsible ? (
            <button
              type="button"
              onClick={() => setExpanded(!expanded)}
              aria-expanded={open}
              className="flex min-w-0 flex-1 items-center gap-2 text-left"
            >
              <h2 className="text-sm font-semibold text-emerald-700 dark:text-emerald-400">{header}</h2>
              <ChevronDown
                size={18}
                className={`shrink-0 text-neutral-400 dark:text-neutral-500 transition-transform ${open ? "rotate-180" : ""}`}
              />
            </button>
          ) : (
            <h2 className="flex-1 text-sm font-semibold text-emerald-700 dark:text-emerald-400">{header}</h2>
          )
        ) : (
          <h2 className="flex-1 text-sm font-semibold text-emerald-700 dark:text-emerald-400">All Notifications</h2>
        )}
        {masterSwitch}
      </div>
      {(locked || canLock || !master) && (
        <p className="mt-1.5 text-xs text-gray-500 dark:text-neutral-400">
          {locked
            ? canLock
              ? `Locked ${master ? "on" : "off"} — ${member.name} can't change it or turn off push on their device. Hold to unlock.`
              : `Locked ${master ? "on" : "off"} by the household owner — these settings can't be changed.`
            : !master
              ? "All notifications are off — nothing below is sent."
              : "Hold the switch to lock it in place."}
        </p>
      )}
      {open && (
        <div className={`mt-3 flex flex-col gap-4 ${master ? "" : "opacity-50"}`}>
          {CATEGORY_ORDER.map((category) => {
            const types = ALL_NOTIFICATION_TYPES.filter((t) => NOTIFICATION_TYPE_META[t].category === category);
            if (types.length === 0) return null;
            return (
              <div key={category}>
                <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-400 dark:text-neutral-500">
                  {category}
                </h3>
                <ul className="mt-2 flex flex-col gap-3">
                  {types.map((type) => {
                    const meta = NOTIFICATION_TYPE_META[type];
                    return (
                      <li key={type} className="flex items-center justify-between gap-3">
                        <span>
                          <p className="text-sm font-medium text-neutral-900 dark:text-neutral-100">{meta.label}</p>
                          <p className="text-xs text-gray-500 dark:text-neutral-400">{meta.description}</p>
                        </span>
                        <Switch
                          checked={state[type]}
                          onChange={() => toggle(type)}
                          disabled={!masterEditable || (pending && pendingType === type)}
                          ariaLabel={meta.label}
                        />
                      </li>
                    );
                  })}
                </ul>
              </div>
            );
          })}
        </div>
      )}
    </li>
  );
}

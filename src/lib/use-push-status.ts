"use client";

import { useEffect, useState, type Dispatch, type SetStateAction } from "react";
import { currentPushSubscription } from "@/lib/push-client";

export type PushStatus = "checking" | "off" | "on" | "denied" | "unsupported";

// Shared detection logic — was inline in NotificationToggle, factored out
// (2026-08-22) so NotificationPushWarning (the dashboard warning-carousel
// card for the unsupported/denied cases) can read the same status without
// duplicating the browser-feature-detection branching. Returns a setter too
// since NotificationToggle still needs to update it optimistically after a
// subscribe/unsubscribe action completes.
export function usePushStatus(): [PushStatus, Dispatch<SetStateAction<PushStatus>>] {
  const [status, setStatus] = useState<PushStatus>("checking");

  // setStatus only ever runs inside the .then()/.catch() callbacks below,
  // never synchronously in the effect body — even the plain browser-support
  // checks are deferred into the callback for this, since a bare setState
  // call in an effect's own synchronous run is exactly the
  // react-hooks/set-state-in-effect trap this repo's lint config catches
  // (see WORKING_ON.md's Theme section — cost real iteration time before).
  useEffect(() => {
    currentPushSubscription()
      .then((sub) => {
        if (typeof Notification === "undefined") setStatus("unsupported");
        else if (Notification.permission === "denied") setStatus("denied");
        else setStatus(sub ? "on" : "off");
      })
      .catch(() => setStatus("unsupported"));
  }, []);

  return [status, setStatus];
}

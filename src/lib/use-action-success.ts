"use client";

import { useEffect, useRef } from "react";

// Next.js doesn't reset a <form>'s fields — or touch any React-controlled
// state alongside it — just because the useActionState action it's bound
// to resolved successfully. Every "Add X" form here (asset, income, bill,
// household member) hits this: submit once, the form silently keeps
// showing what you just typed/picked, easy to mistake for "it kept my
// choices active" when adding a second one. Fires `onSuccess` exactly once
// per submission that completes without an `error` on the returned state —
// callers use it to call formRef.current?.reset() and reset any
// SelectField-backed state (SelectField being controlled, not touched by
// a native reset()) back to its default.
export function useActionSuccess(pending: boolean, hasError: boolean, onSuccess: () => void) {
  const wasPending = useRef(false);
  useEffect(() => {
    if (wasPending.current && !pending && !hasError) onSuccess();
    wasPending.current = pending;
  });
}

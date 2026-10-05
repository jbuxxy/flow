"use client";

import { useEffect, useRef, useState } from "react";
import { resolveActionEdge, showToast } from "@/lib/toast";

// Superset of useActionSuccess (src/lib/use-action-success.ts) — same
// once-per-transition edge detection (a wasPending ref), but it also fires the
// global confirmation toast and exposes `justSaved` for the brief inline
// "✓ Saved" affordance on InlineSaveButton. useActionSuccess stays for the rare
// caller that wants a silent form reset.
//
// Call it in the row/owner component that holds useActionState — never inside a
// <form> or button that unmounts on submit, or the pending true->false edge
// never lands (e.g. pattern-row.tsx closes its editor on success, unmounting
// the form; PatternRow itself stays mounted and fires the toast fine).
//
// The effect lists every dependency and is safe to re-run at will: the edge is
// only ever "success"/"error" on the actual pending true->false transition
// (wasPending is updated first thing), so an extra run from an `onSuccess`
// identity change just re-evaluates to null.

const JUST_SAVED_MS = 1900;

export function useActionToast(
  pending: boolean,
  state: { error?: string },
  opts: { success: string; onSuccess?: () => void; silentError?: boolean },
): { justSaved: boolean } {
  const { success, onSuccess, silentError } = opts;
  const wasPending = useRef(false);
  const [justSaved, setJustSaved] = useState(false);
  const error = state.error;

  useEffect(() => {
    const edge = resolveActionEdge(wasPending.current, pending, error);
    wasPending.current = pending;
    if (edge === "success") {
      showToast(success, "success");
      onSuccess?.();
      setJustSaved(true);
    } else if (edge === "error" && !silentError) {
      showToast(error!, "error");
    }
  }, [pending, error, success, onSuccess, silentError]);

  useEffect(() => {
    if (!justSaved) return;
    const t = setTimeout(() => setJustSaved(false), JUST_SAVED_MS);
    return () => clearTimeout(t);
  }, [justSaved]);

  return { justSaved };
}

// Same edge + toast, for an imperative useTransition row that has no `state`
// object — returns just the `justSaved` boolean for InlineSaveButton.
export function useJustSaved(pending: boolean, hadError: boolean, successMessage: string): boolean {
  const wasPending = useRef(false);
  const [justSaved, setJustSaved] = useState(false);

  useEffect(() => {
    const edge = resolveActionEdge(wasPending.current, pending, hadError ? "error" : undefined);
    wasPending.current = pending;
    if (edge === "success") {
      showToast(successMessage, "success");
      setJustSaved(true);
    }
  }, [pending, hadError, successMessage]);

  useEffect(() => {
    if (!justSaved) return;
    const t = setTimeout(() => setJustSaved(false), JUST_SAVED_MS);
    return () => clearTimeout(t);
  }, [justSaved]);

  return justSaved;
}

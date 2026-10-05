"use client";

import { useSyncExternalStore } from "react";

// App-wide transient confirmation toasts ("Bucket Saved", "Debt Deleted", …).
// A module-level singleton pub-sub read through useSyncExternalStore — the same
// shape as src/lib/use-stored-boolean.ts (getServerSnapshot keeps SSR and first
// client paint agreeing; a tiny Set of listeners is what makes a showToast()
// call from anywhere actually re-render <Toaster />). One stack for the whole
// app, so this is genuinely global state and context would buy nothing — and a
// bare importable showToast() keeps the ~25 imperative startTransition call
// sites (row toggles, deletes, dismissals) from each having to thread a hook.
//
// FIRING RULE: only ever call showToast() from an explicit user-action callback
// or an action's await/.then. Never from render, and never from a useEffect
// keyed on server data — a revalidatePath() re-render must not be able to
// re-fire a toast.

export type ToastTone = "success" | "error" | "info";
export type Toast = { id: number; title: string; tone: ToastTone };

const DISMISS_MS = 2200;
const MAX_TOASTS = 3;

// Replaced (never mutated) on every change, so getSnapshot returns a stable
// reference until the list actually changes — the useSyncExternalStore contract.
let toasts: Toast[] = [];
// Stable shared reference for the server/first-paint snapshot — never mutated
// (every update below replaces `toasts` with a fresh array).
const EMPTY: Toast[] = [];
const listeners = new Set<() => void>();
const timers = new Map<number, ReturnType<typeof setTimeout>>();
let suppressed = false;
let seq = 0;

function emit() {
  listeners.forEach((l) => l());
}

function clearTimer(id: number) {
  const t = timers.get(id);
  if (t !== undefined) {
    clearTimeout(t);
    timers.delete(id);
  }
}

/**
 * Show a transient confirmation toast. Title should be a short Title Case phrase
 * ("Payment Marked Paid"); the default covers the generic case.
 */
export function showToast(title = "Saved", tone: ToastTone = "success"): void {
  if (suppressed) return;

  // Collapse a burst of identical toasts (a bulk "accept all", a multi-step
  // drag-reorder) into one — just restart the newest's dismiss timer.
  const newest = toasts[toasts.length - 1];
  if (newest && newest.title === title && newest.tone === tone) {
    clearTimer(newest.id);
    timers.set(newest.id, setTimeout(() => dismissToast(newest.id), DISMISS_MS));
    return;
  }

  const id = ++seq;
  let next = [...toasts, { id, title, tone }];
  while (next.length > MAX_TOASTS) {
    clearTimer(next[0].id);
    next = next.slice(1);
  }
  toasts = next;
  emit();
  timers.set(id, setTimeout(() => dismissToast(id), DISMISS_MS));
}

export function dismissToast(id: number): void {
  clearTimer(id);
  const next = toasts.filter((t) => t.id !== id);
  if (next.length === toasts.length) return;
  toasts = next;
  emit();
}

/**
 * Silence every toast — used for the read-only example household, where every
 * mutating POST 403s and a flurry of red error toasts is worse than the
 * always-visible "read-only" banner AppShell already renders.
 */
export function setToastsSuppressed(value: boolean): void {
  suppressed = value;
}

function subscribe(callback: () => void): () => void {
  listeners.add(callback);
  return () => listeners.delete(callback);
}

export function useToasts(): Toast[] {
  return useSyncExternalStore(
    subscribe,
    () => toasts,
    () => EMPTY,
  );
}

/**
 * The pending → done edge for a useActionState (or useTransition) action, pulled
 * out as a pure function so it can be unit-tested (hooks can't run under
 * node:test). Returns "success" once per true→false transition with no error,
 * "error" once per true→false transition that left an error, else null.
 */
export function resolveActionEdge(
  wasPending: boolean,
  pending: boolean,
  error: string | undefined,
): "success" | "error" | null {
  if (!wasPending || pending) return null;
  return error ? "error" : "success";
}

// Test-only: reset / inspect module state between cases.
export function __resetToastsForTest(): void {
  timers.forEach((t) => clearTimeout(t));
  timers.clear();
  toasts = [];
  suppressed = false;
  seq = 0;
  listeners.clear();
}

export function __getToastsForTest(): Toast[] {
  return toasts;
}

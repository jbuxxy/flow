"use client";

import { useSyncExternalStore } from "react";

// Generic module-level pub-sub behind every localStorage-backed boolean
// toggle in this app (expand/collapse cards, dismissed banners, …) — see
// CollapsibleWarningCard's useCollapsedState, which now delegates here.
// useSyncExternalStore, not a lazy useState + effect: calling setState
// inside an effect body just to sync from an external source (localStorage)
// is exactly what this hook replaces — getServerSnapshot keeps SSR and
// first client paint agreeing (no hydration mismatch, no flash of the
// "wrong" state), and the real stored value takes over right after. A tiny
// module-level pub-sub (not the native `storage` event, which only fires in
// *other* tabs) is what makes toggling in this tab actually re-render.
const listeners = new Map<string, Set<() => void>>();

function readStored(key: string, defaultValue: boolean): boolean {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? defaultValue : raw === "1";
  } catch {
    return defaultValue;
  }
}

function subscribe(key: string, callback: () => void): () => void {
  let set = listeners.get(key);
  if (!set) {
    set = new Set();
    listeners.set(key, set);
  }
  set.add(callback);
  return () => set.delete(callback);
}

function writeStored(key: string, value: boolean): void {
  try {
    localStorage.setItem(key, value ? "1" : "0");
  } catch {
    // ignore (private browsing etc.)
  }
  listeners.get(key)?.forEach((l) => l());
}

export function useStoredBoolean(key: string, defaultValue = false): [boolean, (next: boolean) => void] {
  const value = useSyncExternalStore(
    (callback) => subscribe(key, callback),
    () => readStored(key, defaultValue),
    () => defaultValue,
  );
  return [value, (next) => writeStored(key, next)];
}

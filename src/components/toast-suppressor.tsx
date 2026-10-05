"use client";

import { useEffect } from "react";
import { setToastsSuppressed } from "@/lib/toast";

// Rendered by AppShell only for the read-only example household — every mutating
// POST 403s there, so a flurry of red error toasts on every tap is worse than
// the persistent "read-only" banner. Keeps AppShell a server component.
export function ToastSuppressor() {
  useEffect(() => {
    setToastsSuppressed(true);
    return () => setToastsSuppressed(false);
  }, []);
  return null;
}

// Shared by every cadence dropdown/tagline in the app (bills, recurring
// patterns) — one canonical set of labels so "Monthly"/"Every 2 Weeks" reads
// identically everywhere instead of each caller writing its own copy.
//
// Deliberately its own tiny, dependency-free file, NOT part of
// recurring-bills.ts (server-only — imports `db`, `@/lib/ai`, etc.): both
// callers that need this (bill-row.tsx, pattern-fields.tsx) are "use client"
// components, and importing a server-only module from client code pulls its
// whole dependency chain into the client bundle — the exact inverse of the
// "use client" boundary bug fixed earlier this session (see WORKING_ON.md,
// 2026-09-11 "a plain helper stuck in a use client file"). Only a type-only
// import from @prisma/client is safe here (erased at build time).
import type { BillCadence } from "@prisma/client";
import { stepCadence } from "@/lib/cadence-step";

export const CADENCE_LABEL: Record<BillCadence, string> = {
  WEEKLY: "Weekly",
  BIWEEKLY: "Every 2 Weeks",
  MONTHLY: "Monthly",
  ANNUAL: "Yearly",
};

// SelectField-ready form of the same map — every real-cadence dropdown
// (BillRow's own, PatternFields' "Real Schedule") lists the same four
// options in the same order; a caller needing an extra leading option (e.g.
// PatternFields' "No Real Schedule") just prepends its own.
export const CADENCE_OPTIONS: { value: BillCadence; label: string }[] = (
  ["WEEKLY", "BIWEEKLY", "MONTHLY", "ANNUAL"] as const
).map((value) => ({ value, label: CADENCE_LABEL[value] }));

// `steps` cadence periods after an ISO "YYYY-MM-DD" date, as the same ISO
// string — the shared, month-end-clamped step (cadence-step.ts), for
// BillRow's edit form and the BNPL schedule: switching a bill's cadence
// re-projects the due date from its last payment, so Monthly -> Yearly on a
// just-paid subscription lands a year out instead of keeping the stale
// one-month-out date (household report 2026-09-30).
export function addCadenceISO(iso: string, cadence: BillCadence, steps = 1): string {
  return stepCadence(new Date(`${iso.slice(0, 10)}T00:00:00Z`), cadence, steps).toISOString().slice(0, 10);
}

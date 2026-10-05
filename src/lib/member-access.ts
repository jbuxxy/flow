import type { Role, DashboardScope } from "@prisma/client";

export type AccessLevel = "OWNER" | "PARTNER" | "BASIC";

// Collapses the underlying Role x DashboardScope matrix into the three
// tiers a household actually uses: Owner (full control, including member
// management), Partner (an adult — 2FA required — who sees everything
// except net worth: bills, debts, income, bank sync), and Basic Access (a
// kid — no 2FA — scoped to buckets/budget only). Nothing in the app makes
// use of the other combinations the matrix technically allows (e.g. a
// non-2FA adult with full financials), so the member-management UI only
// ever creates one of these three, keyed off this single source of truth.
export const ACCESS_LEVELS: Record<
  AccessLevel,
  { role: Role; dashboardScope: DashboardScope; label: string; description: string }
> = {
  OWNER: {
    role: "OWNER",
    dashboardScope: "FULL",
    label: "Owner",
    description: "Full control, including net worth and adding/editing members.",
  },
  PARTNER: {
    role: "PARENT",
    dashboardScope: "FULL",
    label: "Partner",
    description: "Bills, debts, income, and bank sync — not net worth. Requires 2FA.",
  },
  BASIC: {
    role: "CHILD",
    dashboardScope: "BUCKETS_ONLY",
    label: "Basic Access",
    description: "Buckets and budget only. No 2FA required.",
  },
};

export const ACCESS_LEVEL_OPTIONS = (Object.keys(ACCESS_LEVELS) as AccessLevel[]).map((value) => ({
  value,
  label: ACCESS_LEVELS[value].label,
}));

export function accessLevelFor(role: Role, dashboardScope: DashboardScope): AccessLevel {
  if (role === "OWNER") return "OWNER";
  return dashboardScope === "FULL" ? "PARTNER" : "BASIC";
}

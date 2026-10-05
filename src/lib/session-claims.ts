import type { JWT } from "next-auth/jwt";

// The authorization claims a session carries (see auth.config.ts's jwt/
// session callbacks). Sessions are stateless JWTs that Auth.js re-signs on
// every auth() call, so these were frozen at sign-in forever: a deleted
// member kept a working session for as long as they kept using the app, and
// a demoted one kept their old role/scope (2026-10-05 review). auth.ts now
// re-reads the user on each call and applies the live row through here.
export type SessionUserRow = {
  role: string;
  householdId: string;
  dashboardScope: string;
  household: { isDemo: boolean };
};

// null = the account is gone; the caller returns it from the jwt callback,
// which makes Auth.js clear the session cookie.
export function applyLiveClaims(token: JWT, user: SessionUserRow | null): JWT | null {
  if (!user) return null;
  return {
    ...token,
    role: user.role,
    householdId: user.householdId,
    dashboardScope: user.dashboardScope,
    isDemo: user.household.isDemo,
  };
}

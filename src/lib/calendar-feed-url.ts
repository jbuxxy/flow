import { randomBytes } from "node:crypto";
import { db } from "@/lib/db";

// Server-only (imports `db`) — never import this from a "use client"
// component. debts/page.tsx and settings/calendar-sync/actions.ts (both
// server-side) call these directly; a client component gets the resulting
// URL passed down as a prop instead of computing it itself.

// Not hashed — see the Household.calendarFeedToken schema comment for why
// the token itself is the credential a subscribing calendar app presents.
function newToken(): string {
  return randomBytes(24).toString("base64url");
}

export function feedUrlForToken(token: string): string {
  const base = process.env.NEXTAUTH_URL ?? "";
  return `${base}/api/calendar/${token}`;
}

// Lazily creates the household's calendar feed token on first use, so a
// household that never looks at this feature never has an unused token
// sitting in the database. Caller is responsible for any owner-only check —
// this has none of its own so it can also be called from a page that's
// already gated (debts/page.tsx), not just the settings actions.
export async function ensureCalendarFeedToken(householdId: string): Promise<string> {
  const household = await db.household.findUniqueOrThrow({
    where: { id: householdId },
    select: { calendarFeedToken: true },
  });
  if (household.calendarFeedToken) return household.calendarFeedToken;

  const token = newToken();
  await db.household.update({ where: { id: householdId }, data: { calendarFeedToken: token } });
  return token;
}

export async function regenerateCalendarFeedToken(householdId: string): Promise<string> {
  const token = newToken();
  await db.household.update({ where: { id: householdId }, data: { calendarFeedToken: token } });
  return token;
}

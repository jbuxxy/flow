"use server";

import { revalidatePath } from "next/cache";
import { requireOwner } from "@/lib/access";
import {
  feedUrlForToken,
  ensureCalendarFeedToken as ensureCalendarFeedTokenForHousehold,
  regenerateCalendarFeedToken as regenerateCalendarFeedTokenForHousehold,
} from "@/lib/calendar-feed-url";

// Lazily creates the household's calendar feed token on first visit to the
// settings page (see the lib helper for why nothing happens until then).
// Returns the full feed URL, not the bare token — the client panel never
// needs to know the URL-building convention itself.
export async function ensureCalendarFeedUrl(): Promise<string> {
  const { user } = await requireOwner();
  const token = await ensureCalendarFeedTokenForHousehold(user.householdId);
  return feedUrlForToken(token);
}

// Invalidates the previous link (e.g. accidentally shared, or a member left
// the household) and hands back a fresh one — the old URL 404s immediately
// after this runs.
export async function regenerateCalendarFeedUrl(): Promise<string> {
  const { user } = await requireOwner();
  const token = await regenerateCalendarFeedTokenForHousehold(user.householdId);
  revalidatePath("/settings/calendar-sync");
  revalidatePath("/debts");
  return feedUrlForToken(token);
}

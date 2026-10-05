import { db } from "@/lib/db";
import { getPaymentCalendarIcsEvents } from "@/lib/debt-payments";
import { buildIcsCalendar } from "@/lib/ics";

// Public, unauthenticated by design — a subscribing calendar app (Google/
// Apple) has no way to send a session cookie or a header on its own refetch
// cadence, so the token in the URL path IS the credential (see
// Household.calendarFeedToken's schema comment and /settings/calendar-sync,
// where an owner generates/rotates it). 404 rather than 401/403 on a
// missing or stale token — doesn't confirm to a prober which case it is.
//
// One feed: the full payment calendar — every recurring bill / subscription,
// every debt minimum, and the payoff plan's extra payments when it's running,
// 3 months out. (An early build briefly split this into two feeds via
// `?view=`; any query string is now just ignored.)
export async function GET(_request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;

  const household = await db.household.findUnique({
    where: { calendarFeedToken: token },
    select: { id: true, name: true },
  });
  if (!household) {
    return new Response("Not found", { status: 404 });
  }

  const events = await getPaymentCalendarIcsEvents(household.id);
  const ics = buildIcsCalendar(`${household.name} — Payment Calendar`, events);

  return new Response(ics, {
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": 'inline; filename="payment-calendar.ics"',
      "Cache-Control": "private, max-age=3600",
    },
  });
}

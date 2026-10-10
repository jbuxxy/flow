// Minimal RFC 5545 iCalendar builder for a read-only, all-day-event
// PUBLISH feed (see /api/calendar/[token]/route.ts). Not a general ICS
// library — no timed events, no recurrence rules, no attendees, just
// enough to hand Google/Apple Calendar a subscribable list of dated
// events. Pure/no imports, same "client-safe" split convention as
// debt-payoff.ts (kept separate from debt-payments.ts, which needs `db`).

export type IcsEvent = {
  // Stable across regenerations of the same underlying event (e.g.
  // `${debtId}-${kind}-${yyyymmdd}`) — subscribing calendar apps use this
  // to reconcile a re-fetched feed against what they already show, so an
  // event whose projected date hasn't changed shouldn't get a new UID.
  uid: string;
  // Rendered as an all-day event — every date this feed deals in (due
  // dates, projected paycheck dates) is a UTC-midnight calendar day, not a
  // specific time (see src/lib/date.ts's formatDate doc comment).
  date: Date;
  summary: string;
  description?: string;
};

// A bare \r (or \r\n) is normalized to \n first — left raw, a strict
// parser reads it as the start of a new content line.
function escapeIcsText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\n/g, "\\n");
}

// RFC 5545 caps a content line at 75 octets, continued by a line starting
// with a single space — SUMMARY/DESCRIPTION here are normally short, but
// this keeps the feed spec-compliant if a debt name or pool breakdown ever
// runs long. Counts UTF-8 octets and never splits a character: slicing by
// UTF-16 units used to cut an emoji's surrogate pair in half (garbled
// titles in the subscribed calendar) and let multibyte lines run past 75
// octets (2026-10-08 review). Exported for its unit test.
export function foldLine(line: string): string {
  const encoder = new TextEncoder();
  const lines: string[] = [];
  let current = "";
  let currentOctets = 0;
  let limit = 75; // continuation lines get 74 + the leading space
  for (const ch of line) {
    const octets = encoder.encode(ch).length;
    if (currentOctets + octets > limit) {
      lines.push(current);
      current = "";
      currentOctets = 0;
      limit = 74;
    }
    current += ch;
    currentOctets += octets;
  }
  lines.push(current);
  return lines.join("\r\n ");
}

// "20261023" — the UTC calendar day in iCalendar's DATE form.
export function ymd(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}${m}${d}`;
}

function addDaysUtc(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

export function buildIcsCalendar(calendarName: string, events: IcsEvent[]): string {
  const now = new Date();
  const dtstamp = `${ymd(now)}T${String(now.getUTCHours()).padStart(2, "0")}${String(now.getUTCMinutes()).padStart(2, "0")}${String(now.getUTCSeconds()).padStart(2, "0")}Z`;
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Flow//Payment Calendar//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${escapeIcsText(calendarName)}`,
    // A hint most clients respect for how often to re-poll a subscribed
    // feed — Google/Apple both still poll on their own schedule regardless
    // (the settings page's own copy already sets that expectation).
    "X-PUBLISHED-TTL:PT12H",
    "REFRESH-INTERVAL;VALUE=DURATION:PT12H",
  ];
  for (const event of events) {
    lines.push(
      "BEGIN:VEVENT",
      `UID:${event.uid}@flow.local`,
      `DTSTAMP:${dtstamp}`,
      `DTSTART;VALUE=DATE:${ymd(event.date)}`,
      `DTEND;VALUE=DATE:${ymd(addDaysUtc(event.date, 1))}`,
      `SUMMARY:${escapeIcsText(event.summary)}`,
    );
    if (event.description) lines.push(`DESCRIPTION:${escapeIcsText(event.description)}`);
    lines.push("TRANSP:TRANSPARENT", "END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return lines.map(foldLine).join("\r\n") + "\r\n";
}

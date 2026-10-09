import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { buildIcsCalendar, foldLine } from "@/lib/ics";
import { utc } from "../helpers.ts";

describe("buildIcsCalendar", () => {
  const cal = buildIcsCalendar("Flow Payoff", [
    { uid: "d1-minimum-20260315", date: utc(2026, 3, 15), summary: "Minimum: Visa", description: "Due today" },
  ]);

  test("wraps a VCALENDAR with a single all-day VEVENT", () => {
    assert.match(cal, /BEGIN:VCALENDAR/);
    assert.match(cal, /END:VCALENDAR\r\n$/);
    assert.match(cal, /DTSTART;VALUE=DATE:20260315/);
    assert.match(cal, /DTEND;VALUE=DATE:20260316/); // exclusive end = date + 1
    assert.match(cal, /UID:d1-minimum-20260315@flow\.local/);
    assert.match(cal, /SUMMARY:Minimum: Visa/);
  });

  test("X-WR-CALNAME is the passed name; PRODID is the static app identifier", () => {
    assert.match(cal, /X-WR-CALNAME:Flow Payoff\r\n/);
    assert.match(cal, /PRODID:-\/\/Flow\/\/Payment Calendar\/\/EN\r\n/);
  });

  test("CRLF line endings", () => {
    assert.ok(cal.includes("\r\n"));
    assert.ok(!/[^\r]\n/.test(cal));
  });

  test("escapes ; , \\ and newlines in text", () => {
    const escaped = buildIcsCalendar("X", [
      { uid: "u", date: utc(2026, 1, 1), summary: "a; b, c\\d", description: "line1\nline2" },
    ]);
    assert.match(escaped, /SUMMARY:a\\; b\\, c\\\\d/);
    assert.match(escaped, /DESCRIPTION:line1\\nline2/);
  });

  test("folds a content line longer than 75 octets", () => {
    const long = "x".repeat(200);
    const folded = buildIcsCalendar("X", [{ uid: "u", date: utc(2026, 1, 1), summary: long }]);
    const summaryLines = folded.split("\r\n").filter((l) => l.startsWith("SUMMARY") || l.startsWith(" "));
    assert.ok(summaryLines.length > 1);
    assert.ok(summaryLines.every((l) => l.length <= 75));
  });

  test("the UID is stable for the same event", () => {
    const a = buildIcsCalendar("X", [{ uid: "d1-x-20260101", date: utc(2026, 1, 1), summary: "s" }]);
    const b = buildIcsCalendar("X", [{ uid: "d1-x-20260101", date: utc(2026, 1, 1), summary: "s" }]);
    assert.equal(a.match(/UID:[^\r]+/)![0], b.match(/UID:[^\r]+/)![0]);
  });
});

describe("foldLine", () => {
  const octets = (s: string) => new TextEncoder().encode(s).length;

  test("never splits an emoji, and every physical line stays within 75 octets", () => {
    // Regression (2026-10-08 review): folding by UTF-16 units cut the
    // surrogate pair at position 75 in half.
    const line = "SUMMARY:" + "a".repeat(66) + "🏠" + "b".repeat(80) + "é".repeat(40);
    const folded = foldLine(line);
    assert.ok(!folded.includes("�"));
    const physical = folded.split("\r\n");
    for (const p of physical) assert.ok(octets(p) <= 75, `${octets(p)} octets`);
    // Unfolding (drop CRLF + one space) restores the original exactly.
    assert.equal(folded.replace(/\r\n /g, ""), line);
  });

  test("a short line is untouched", () => {
    assert.equal(foldLine("SUMMARY:Visa"), "SUMMARY:Visa");
  });
});

describe("text escaping", () => {
  test("a bare CR can't start a new content line", () => {
    const cal = buildIcsCalendar("Flow", [{ uid: "x", date: utc(2026, 3, 15), summary: "Gas\rDTSTART:19700101" }]);
    assert.match(cal, /SUMMARY:Gas\\nDTSTART:19700101/);
    assert.doesNotMatch(cal, /\rDTSTART:1970/);
  });
});

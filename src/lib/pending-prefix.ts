// SimpleFIN prefixes a not-yet-posted charge's description ("Pending Lakeside
// Foods", "PENDING - 08/23 - ..."). Split out of simplefin-sync.ts (which pulls
// in the db + sync machinery) so display code can share the same strip rule the
// pending→posted reconciliation uses.
export function stripPendingPrefix(s: string): string {
  return s.replace(/^\s*pending\b[\s:_-]*/i, "").trim();
}

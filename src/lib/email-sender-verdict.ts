// Cuts the AI bill for email receipt reading (2026-10-23: about half the
// emails clearing the prefilter came back "not a receipt", and most calls
// carried 1-2 emails under a ~2.7K-token instruction block). Two levers,
// both pure here so they're unit-tested; receipt-sync.ts does the I/O:
//
//   - a learned skip list: each AI verdict is tallied per sender and per
//     sender + subject shape (EmailSenderStat). A sender that has never sent
//     a receipt or bill notice, or a subject shape that keeps coming back
//     "not a receipt", stops being sent to the AI — rechecked once the
//     verdict it rests on is SKIP_RECHECK_MS old, so a sender that starts
//     sending real receipts is picked back up.
//   - batching: a routine sync holds a few fresh candidates until
//     EXTRACT_BATCH_SIZE are waiting or the oldest has waited
//     EXTRACT_MAX_WAIT_MS. Bank charges take a day or more to post, so the
//     delay costs no matches. Raised 10/3h → 20/12h on 2026-10-28: once
//     Amazon's emails stopped going to the AI (parseAmazonOrderEmail) only
//     ~7 candidates a day remained, so the fixed instruction block was most
//     of every call — fewer, fuller calls are the remaining lever.

export const SENDER_SKIP_AFTER = 5; // non-receipts from a sender that's never sent a receipt
export const SUBJECT_SKIP_AFTER = 3; // non-receipts in a row for one sender + subject shape
export const SKIP_RECHECK_MS = 30 * 24 * 60 * 60 * 1000;
export const EXTRACT_BATCH_SIZE = 20;
export const EXTRACT_MAX_WAIT_MS = 12 * 60 * 60 * 1000;

// The sender-level row's subjectKey.
export const ANY_SUBJECT = "";

export type SenderStat = {
  usefulCount: number;
  uselessCount: number;
  uselessStreak: number;
  lastAiCheckAt: Date;
};

// "Amazon.com <auto-confirm@amazon.com>" → "auto-confirm@amazon.com"; a bare
// address (or anything without brackets) is lowercased as-is.
export function senderKey(from: string): string {
  const bracketed = from.match(/<([^>]+)>/);
  return (bracketed ? bracketed[1] : from).trim().toLowerCase();
}

// The subject with what varies per email taken out — quoted product names,
// amounts, order/ID numbers — so "Your order #112-4471 of $18.18" and
// "Your order #113-9902 of $7.51" share one shape.
export function subjectKey(subject: string): string {
  return subject
    .toLowerCase()
    .replace(/^\s*((re|fwd?|fw)\s*:\s*)+/, "")
    .replace(/["“][^"”]*["”]/g, "\"…\"")
    .replace(/\$\s*[\d,]+(\.\d+)?/g, "$#")
    .replace(/\d+/g, "#")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

const fresh = (s: SenderStat, now: Date) => now.getTime() - s.lastAiCheckAt.getTime() < SKIP_RECHECK_MS;

export function shouldSkipEmail(
  sender: SenderStat | null | undefined,
  subject: SenderStat | null | undefined,
  now: Date,
): boolean {
  if (sender && sender.usefulCount === 0 && sender.uselessCount >= SENDER_SKIP_AFTER && fresh(sender, now)) {
    return true;
  }
  return !!subject && subject.uselessStreak >= SUBJECT_SKIP_AFTER && fresh(subject, now);
}

export function shouldDeferExtraction(candidates: { receivedAt: Date }[], now: Date): boolean {
  if (candidates.length === 0 || candidates.length >= EXTRACT_BATCH_SIZE) return false;
  const oldest = Math.min(...candidates.map((c) => c.receivedAt.getTime()));
  return now.getTime() - oldest < EXTRACT_MAX_WAIT_MS;
}

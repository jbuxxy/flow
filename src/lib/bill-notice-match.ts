// Shared "which tracked bill/debt does this parsed 'amount due' email belong
// to?" gating — used by both the automatic matcher (matchBillNoticeAmounts,
// src/lib/bill-notice-sync.ts) and the manual linker
// (src/app/settings/email/page.tsx), the same way bnpl-plan-match.ts is
// shared across the receipt-match paths.
//
// A bill-notice email has no transaction to match against — it arrives
// before any payment posts — so the primary signal is the extracted biller
// name against the household's existing RecurringBill/Debt names. Real case
// (2026-09-22): a household with four Klarna installment plans ("Klarna -
// Nike 2", "Klarna - Puma", "Nike - Klarna", "GlassesUSA.com - Klarna") got a
// "Klarna" notice — every plan's name contains "Klarna" as a whole word, so
// they all score identically on name alone (nameSimilarity's substring/
// word-subset tier). Name ties are broken by the notice's own stated amount
// against each candidate's currently tracked amount (see
// pickAmountTiebreak) — but only among candidates the name match already
// judged plausible; amount is never enough on its own to rescue a
// wrong-named candidate. A low-confidence or still-undecided result only
// ever produces AMBIGUOUS here (never an auto-pick), since the review it
// feeds is human-confirmed either way — the cost of guessing wrong is a
// wasted question, not a wrong dollar amount written anywhere.

import { nameSimilarity } from "@/lib/fuzzy-match";

export type BillNoticeMatchCandidate = {
  id: string;
  name: string;
  amountCents: number;
  // Other names the biller might go by — for a debt, its linked account's
  // institution ("Chase Bank") and raw synced name. A card's notice comes from
  // the *issuer*, which a co-branded card's own name rarely mentions (real
  // case, 2026-10-03: a "Chase" notice for "Amazon Prime Rewards Visa
  // Signature" sat UNMATCHED). Scored the same as `name`, best one wins.
  aliases?: string[];
  // Account-number endings this candidate is known by (the "(4321)" a synced
  // account name carries). A notice quoting a last-4 that exactly one
  // candidate has is a match on its own — it's the account itself.
  last4s?: string[];
};

// Every standalone 4-digit run in a string — "Visa Signature (4321)" → 4321.
export function last4sIn(...texts: (string | null | undefined)[]): string[] {
  const out = new Set<string>();
  for (const t of texts) for (const m of (t ?? "").matchAll(/(?<!\d)(\d{4})(?!\d)/g)) out.add(m[1]);
  return [...out];
}

export type BillNoticeMatchResult =
  | { outcome: "MATCH"; type: "BILL" | "DEBT"; id: string }
  | { outcome: "AMBIGUOUS" }
  | { outcome: "UNMATCHED" };

// Below this, a name doesn't resemble the biller enough to even ask about.
const MATCH_FLOOR = 0.5;
// The top candidate must clear the runner-up by this much to auto-pick on
// name alone instead of trying the amount tiebreak / asking which one.
const MATCH_MARGIN = 0.15;

// How close a candidate's own tracked amount must sit to the notice's stated
// amount to trust it as "the same one" — generous enough to allow for the
// exact drift this pipeline exists to detect (a plan whose payment went up
// or down a little), not so generous it'd paper over picking the wrong plan.
const AMOUNT_TIEBREAK_ABS_CENTS = 500; // $5
// The runner-up (by amount, within the name-tied group) must sit at least
// this many times farther from the notice's amount than the winner — a
// clear-dominance bar, not just "slightly closer."
const AMOUNT_TIEBREAK_RATIO = 3;

type Scored = { type: "BILL" | "DEBT"; id: string; amountCents: number; score: number };

// Among a set of candidates name similarity alone can't separate, pick the
// one whose own tracked amount sits decisively closest to what the notice
// says is due — null when no candidate is a decisive amount match either.
function pickAmountTiebreak(contenders: Scored[], noticeAmountCents: number): Scored | null {
  const byAmount = contenders
    .map((c) => ({ ...c, amountDiff: Math.abs(c.amountCents - noticeAmountCents) }))
    .sort((a, b) => a.amountDiff - b.amountDiff);
  const [closest, runnerUp] = byAmount;
  const decisive =
    closest.amountDiff <= AMOUNT_TIEBREAK_ABS_CENTS &&
    (!runnerUp || (runnerUp.amountDiff > closest.amountDiff && runnerUp.amountDiff >= closest.amountDiff * AMOUNT_TIEBREAK_RATIO));
  return decisive ? closest : null;
}

export function pickBillNoticeMatch(
  billerName: string,
  noticeAmountCents: number,
  bills: BillNoticeMatchCandidate[],
  debts: BillNoticeMatchCandidate[],
  accountLast4?: string | null,
): BillNoticeMatchResult {
  const bestScore = (c: BillNoticeMatchCandidate) =>
    Math.max(nameSimilarity(billerName, c.name), ...(c.aliases ?? []).map((a) => nameSimilarity(billerName, a)));
  const scored: Scored[] = [
    ...bills.map((b) => ({ type: "BILL" as const, id: b.id, amountCents: b.amountCents, score: bestScore(b) })),
    ...debts.map((d) => ({ type: "DEBT" as const, id: d.id, amountCents: d.amountCents, score: bestScore(d) })),
  ].sort((a, b) => b.score - a.score);

  // Strongest signal first: the notice names the account, and exactly one
  // tracked bill/debt carries that ending — unless the biller name points
  // somewhere else. A BNPL notice often quotes the *funding* card's ending
  // ("charged to card ending 1234"), which can collide with an unrelated
  // tracked account's (real case, 2026-10-05: a small "Klarna" installment
  // notice matched an auto loan ending in the same four digits and asked
  // whether the loan's minimum had dropped to the installment amount). So the last-4 only decides when the hit's own name
  // resembles the biller, or when no candidate's name does at all.
  if (accountLast4 && /^\d{4}$/.test(accountLast4)) {
    const hits = [
      ...bills.filter((b) => b.last4s?.includes(accountLast4)).map((b) => ({ type: "BILL" as const, id: b.id, score: bestScore(b) })),
      ...debts.filter((d) => d.last4s?.includes(accountLast4)).map((d) => ({ type: "DEBT" as const, id: d.id, score: bestScore(d) })),
    ];
    const nameFitsSomething = scored.some((c) => c.score >= MATCH_FLOOR);
    if (hits.length === 1 && (hits[0].score >= MATCH_FLOOR || !nameFitsSomething)) {
      return { outcome: "MATCH", type: hits[0].type, id: hits[0].id };
    }
  }

  const plausible = scored.filter((c) => c.score >= MATCH_FLOOR);

  if (plausible.length === 0) return { outcome: "UNMATCHED" };
  if (plausible.length === 1) return { outcome: "MATCH", type: plausible[0].type, id: plausible[0].id };

  const topScore = plausible[0].score;
  const contenders = plausible.filter((c) => topScore - c.score < MATCH_MARGIN);
  if (contenders.length === 1) return { outcome: "MATCH", type: contenders[0].type, id: contenders[0].id };

  const winner = pickAmountTiebreak(contenders, noticeAmountCents);
  if (winner) return { outcome: "MATCH", type: winner.type, id: winner.id };
  return { outcome: "AMBIGUOUS" };
}

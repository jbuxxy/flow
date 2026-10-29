// Reduces a fetched email to the text the receipt extractor actually needs —
// every character left here is billed on every AI call that carries it.
// Pure (no imapflow/db) so the prefilter replay and tests can run it.
//
// 2026-10-28 replay of 30 days of household mail (4,648 msgs): the bodies
// sent to the AI averaged 1.3K chars for a real receipt but 2.9K for a
// non-receipt, and much of both was footer legal text, "recently viewed"
// product carousels, zero-width spacer runs, and html-only mail (Venmo)
// flattened to one line so nothing could be cut by line.

export const MAX_BODY_CHARS = 4_000;

// Links are dropped before the cap: the extractor never needs a URL, and
// tracking links were ~45% of even real receipts' text (2026-10-24 replay of
// 30 days of household mail) — billed tokens that also crowded real content
// out of the cap.
export function stripLinks(text: string): string {
  return text
    .replace(/<?https?:\/\/[^\s>)\]]+>?/g, "")
    .replace(/\[\s*\]|\(\s*\)/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n");
}

const ENTITIES: Record<string, string> = { nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", zwnj: "", zwj: "", shy: "" };

// Block-level tags become line breaks so the footer/section cuts below can
// work by line — the old strip collapsed every html-only email to one line.
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|head|title)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(br|\/p|\/div|\/tr|\/li|\/h[1-6]|\/table|hr)\b[^>]*>/gi, "\n")
    .replace(/<\/t[dh]>/gi, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m);
}

// Zero-width / invisible spacer characters (preheader padding — one big-box
// retailer's orders carry hundreds) and non-breaking spaces.
const INVISIBLE_RE = /[​-‏­͏⁠﻿᠎]/g;
const NBSP_RE = /[   ]/g;

const MONEY_LINE_RE = /[$€£]\s?\d|\b\d[\d,]*\.\d{2}\b/;

// Where a receipt's content ends: legal/footer boilerplate and "keep
// shopping" carousels. Only honored *after* the last money line (see
// cleanEmailBody), so a marker above the total can never cut it off.
const FOOTER_RE =
  /unsubscribe|privacy (policy|notice|statement)|all rights reserved|©|\(c\) ?\d{4}|conditions of use|terms (of (use|service)|(&|and) conditions)|(please )?do not reply|don't reply to this|this (e-?mail|message) was sent|you('re| are) receiving this|manage (your )?(email |communication |notification )?(preferences|settings)|which messages you receive|download (on|the)\b.*\bapp|get it on google play|visit us on|follow us|help center|customer service|questions\?|for any issues|recently viewed|you (may|might) also like|recommended for you|customers (also )?(bought|viewed)|explore more|more to explore/i;

// A line repeated verbatim (Venmo states "You paid X $8.50" three times; nav
// rows repeat) only needs to be sent once. Short lines ("Qty: 1", "$5.00")
// are kept — they're positional within an itemization.
const DEDUPE_MIN_CHARS = 12;

export function cleanEmailBody(text: string, maxChars = MAX_BODY_CHARS): string {
  const lines = stripLinks(text.replace(INVISIBLE_RE, "").replace(NBSP_RE, " ").replace(/\r/g, ""))
    .split("\n")
    .map((l) => l.replace(/[ \t]+/g, " ").trim())
    .filter((l) => l.length > 0 && /[\p{L}\p{N}$€£]/u.test(l));

  let lastMoney = -1;
  lines.forEach((l, i) => {
    if (MONEY_LINE_RE.test(l)) lastMoney = i;
  });
  let end = lines.length;
  for (let i = lastMoney + 1; i < lines.length; i++) {
    if (FOOTER_RE.test(lines[i])) {
      end = i;
      break;
    }
  }

  const seen = new Set<string>();
  const kept: string[] = [];
  for (const l of lines.slice(0, end)) {
    if (l.length >= DEDUPE_MIN_CHARS) {
      const key = l.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
    }
    kept.push(l);
  }
  return kept.join("\n").slice(0, maxChars);
}

export function bodyText(parsedText: string | undefined, parsedHtml: string | false | undefined): string {
  if (parsedText && parsedText.trim()) return cleanEmailBody(parsedText);
  if (typeof parsedHtml === "string" && parsedHtml.trim()) return cleanEmailBody(htmlToText(parsedHtml));
  return "";
}

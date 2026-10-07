import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { curatedLogoUrl, debtLogoSearchText, getCuratedDomain, getCuratedDomains, getMerchantLogoUrl } from "@/lib/merchant-domains";

describe("getCuratedDomain", () => {
  test("matches a well-known merchant regardless of case", () => {
    assert.equal(getCuratedDomain("VERIZON WIRELESS PAYMENT"), "verizon.com");
  });

  test("returns null for an unrecognized merchant", () => {
    assert.equal(getCuratedDomain("Fairview Water Improvement District"), null);
  });

  test("matches a BNPL provider as a substring of a composite debt name", () => {
    assert.equal(getCuratedDomain("Nike - Klarna"), "klarna.com");
  });

  test("matches a possessive brand name with a curly apostrophe, not just a straight one", () => {
    // Real report, 2026-09-14: a household-renamed account ("Sam’s Club
    // Card") stores a curly apostrophe (U+2019, what iOS text fields
    // produce by default) — the pattern itself only spells the straight one.
    assert.equal(getCuratedDomain("Sam’s Club Card"), "samsclub.com");
    assert.equal(getCuratedDomain("Sam's Club Card"), "samsclub.com"); // straight still works too
  });

  test("matches Discover's own product name, not just the word \"card\"", () => {
    assert.equal(getCuratedDomain("Discover it (4417)"), "discover.com");
  });

  test("doesn't confuse Discover with Discovery+/Discovery Channel", () => {
    assert.equal(getCuratedDomain("Discovery+"), "discoveryplus.com");
    assert.notEqual(getCuratedDomain("Discovery Channel"), "discover.com");
  });

  test("Amex's alternation is properly grouped — doesn't match a substring mid-word", () => {
    assert.equal(getCuratedDomain("AMEX Blue Cash"), "americanexpress.com");
    assert.equal(getCuratedDomain("Megamex Foods"), null); // ends in "...amex" but isn't Amex
  });

  test("Lumen's alternation is properly grouped — doesn't match the bare English word", () => {
    assert.equal(getCuratedDomain("CenturyLink"), "lumen.com");
    assert.equal(getCuratedDomain("1000 Lumens LED Bulb"), null);
  });

  test("matches Puma and Best Egg", () => {
    assert.equal(getCuratedDomain("Klarna - Puma"), "klarna.com"); // klarna wins, listed first
    assert.equal(getCuratedDomain("Puma"), "puma.com");
    assert.equal(getCuratedDomain("Best Egg"), "bestegg.com");
  });
});

describe("getCuratedDomains", () => {
  test("a composite retailer+provider name returns both domains", () => {
    const domains = getCuratedDomains("Nike - Klarna");
    assert.deepEqual([...domains].sort(), ["klarna.com", "nike.com"]);
  });

  test("word order doesn't change which domains match", () => {
    const forward = getCuratedDomains("Nike - Klarna");
    const reversed = getCuratedDomains("Klarna - Nike");
    assert.deepEqual([...forward].sort(), [...reversed].sort());
  });

  test("a single-match merchant returns a one-element array", () => {
    assert.deepEqual(getCuratedDomains("VERIZON WIRELESS PAYMENT"), ["verizon.com"]);
  });

  test("an unrecognized merchant returns an empty array", () => {
    assert.deepEqual(getCuratedDomains("Fairview Water Improvement District"), []);
  });

  test("respects the max cap", () => {
    // Amazon + Chase both appear in a contrived combined string — capped to 1.
    const domains = getCuratedDomains("Amazon Chase Card", 1);
    assert.equal(domains.length, 1);
  });

  test("never returns a duplicate domain for a name matching the same pattern twice", () => {
    const domains = getCuratedDomains("Klarna Klarna");
    assert.deepEqual(domains, ["klarna.com"]);
  });

  test("Klarna - Puma (the real reported case) returns both logos", () => {
    const domains = getCuratedDomains("Klarna - Puma");
    assert.deepEqual([...domains].sort(), ["klarna.com", "puma.com"]);
  });

  test("the BNPL provider leads even when its retailer sits earlier in the table", () => {
    // Walmart's pattern (Superstores) precedes Klarna's (Finance) — real
    // report, 2026-10-07: "Klarna - Walmart" showed Walmart's logo first.
    assert.deepEqual(getCuratedDomains("Klarna - Walmart"), ["klarna.com", "walmart.com"]);
    assert.deepEqual(getCuratedDomains("Walmart - Affirm"), ["affirm.com", "walmart.com"]);
  });

  test("max 1 on a BNPL name keeps the provider, not the retailer", () => {
    assert.deepEqual(getCuratedDomains("Klarna - Walmart", 1), ["klarna.com"]);
  });

  test("the single-logo lookup keeps table order (merchant beats payment rail)", () => {
    assert.equal(getCuratedDomain("PAYPAL *NETFLIX"), "netflix.com");
  });
});

describe("debtLogoSearchText", () => {
  test("Capital One Venture: raw name alone finds nothing, falls back to orgName", () => {
    // The real reported case — the raw synced Account.name is just
    // "Venture (3021)" (no "Capital One" in it); only orgName carries the
    // brand, so it has to be reached for here.
    const text = debtLogoSearchText("Venture (3021)", "Venture (3021)", "Capital One");
    assert.deepEqual(getCuratedDomains(text), ["capitalone.com"]);
  });

  test("Discover it: raw name alone already resolves, so an inaccurate orgName is never searched", () => {
    // The real reported case that motivated the tiering — this household's
    // Discover card reports orgName "Capital One" despite the raw synced
    // name already correctly saying "Discover it." Appending orgName
    // unconditionally produced a false second brand icon alongside the
    // real one ("revert the double brand icon", household report,
    // 2026-09-14) — tiering behind "did the reliable text already find
    // something" keeps this to just discover.com.
    const text = debtLogoSearchText("Discover it (4417)", "Discover it (4417)", "Capital One");
    assert.deepEqual(getCuratedDomains(text), ["discover.com"]);
  });

  test("displayed name alone already resolves — no need to reach for the raw name or orgName at all", () => {
    const text = debtLogoSearchText("Klarna - Nike", "Some Other Raw Name", "Some Org");
    assert.deepEqual([...getCuratedDomains(text)].sort(), ["klarna.com", "nike.com"]);
  });

  test("no account linked (manual debt) — just the displayed name, no crash", () => {
    const text = debtLogoSearchText("Sapphire Rewards Card", null, null);
    assert.equal(text, "Sapphire Rewards Card");
  });

  test("nothing resolves at any tier — falls through to the fullest search text, still no crash", () => {
    const text = debtLogoSearchText("Home Mortgage", "Summit Home Loans 123 Main St", "Some Org");
    assert.deepEqual(getCuratedDomains(text), []);
  });
});

describe("getMerchantLogoUrl", () => {
  test("builds a logo URL from the curated domain", () => {
    assert.equal(getMerchantLogoUrl("Netflix"), "https://www.google.com/s2/favicons?domain=netflix.com&sz=64");
  });

  test("returns null when nothing curated matches", () => {
    assert.equal(getMerchantLogoUrl("Cedar Creek Irrigation Debits Web"), null);
  });
});

describe("curatedLogoUrl", () => {
  test("defaults to the favicon (compact mark), not Hunter's wordmark", () => {
    assert.equal(curatedLogoUrl("walmart.com"), "https://www.google.com/s2/favicons?domain=walmart.com&sz=64");
  });

  test("a domain with no Google favicon stays on Hunter", () => {
    assert.equal(curatedLogoUrl("allstate.com"), "https://logos.hunter.io/allstate.com");
  });
});

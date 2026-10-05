// ---------------------------------------------------------------------------
// Merchant-name → domain resolution
// ---------------------------------------------------------------------------
// Curated fast path: pattern-matched against the lowercased merchant string,
// first match wins, zero network cost. Entries are ordered from
// most-specific to most-generic where names overlap. Plain data/functions
// only (no "use client", no DB) so this is safely importable from both the
// client-side MerchantLogo component and server-side resolution code in
// merchant-logo-resolve.ts.

const MERCHANT_DOMAINS: [RegExp, string][] = [
  // Groceries / Warehouse
  [/\bcostco\b/, "costco.com"],
  [/\bsam[' ]?s club\b/, "samsclub.com"],
  [/\btrader joe\b/, "traderjoes.com"],
  [/\bwhole foods\b/, "wholefoodsmarket.com"],
  [/\bkroger\b/, "kroger.com"],
  [/\bsafeway\b/, "safeway.com"],
  [/\bpublix\b/, "publix.com"],
  [/\baldi\b/, "aldi.us"],
  [/\bwegmans\b/, "wegmans.com"],
  [/\bheb\b/, "heb.com"],
  [/\bsprouts\b/, "sprouts.com"],
  [/\bstop &? ?shop\b/, "stopandshop.com"],
  [/\bfood lion\b/, "foodlion.com"],

  // Superstores / Mass Retail
  [/\bwalmart\b/, "walmart.com"],
  [/\btarget\b/, "target.com"],
  [/\bkohl[' ]?s\b/, "kohls.com"],
  [/\bkmart\b/, "kmart.com"],
  [/\bmacy[' ]?s\b/, "macys.com"],
  [/\bnordstrom\b/, "nordstrom.com"],
  [/\bjcpenney\b/, "jcpenney.com"],
  [/\bmarshalls\b/, "marshalls.com"],
  [/\bt\.? ?j\.? ?maxx\b/, "tjmaxx.com"],
  [/\bbest buy\b/, "bestbuy.com"],
  [/\bhome depot\b/, "homedepot.com"],
  [/\blowe[' ]?s\b/, "lowes.com"],

  // Online Retail
  [/\bamazon\b/, "amazon.com"],
  [/\bebay\b/, "ebay.com"],
  [/\betsy\b/, "etsy.com"],
  [/\bwayfair\b/, "wayfair.com"],
  [/\bchewy\b/, "chewy.com"],
  [/\bnewegg\b/, "newegg.com"],
  [/\boverstock\b/, "overstock.com"],

  // Food / Fast Food / Coffee
  [/\bmcdonald[' ]?s\b/, "mcdonalds.com"],
  [/\bstarbucks\b/, "starbucks.com"],
  [/\bchick-?fil-?a\b/, "chick-fil-a.com"],
  [/\bsubway\b(?! transit)/, "subway.com"],
  [/\btaco bell\b/, "tacobell.com"],
  [/\bchipotle\b/, "chipotle.com"],
  [/\bdunkin[' ]?\b/, "dunkindonuts.com"],
  [/\bdomino[' ]?s\b/, "dominos.com"],
  [/\bpizza hut\b/, "pizzahut.com"],
  [/\bpapa john[' ]?s\b/, "papajohns.com"],
  [/\bwendy[' ]?s\b/, "wendys.com"],
  [/\bburger king\b/, "burgerking.com"],
  [/\bin-?n-?out\b/, "in-n-out.com"],
  [/\bfive guys\b/, "fiveguys.com"],
  [/\bshake shack\b/, "shakeshack.com"],
  [/\bwhataburger\b/, "whataburger.com"],
  [/\bjack in the box\b/, "jackinthebox.com"],
  [/\bcarl[' ]?s jr\b/, "carlsjr.com"],
  [/\bhardee[' ]?s\b/, "hardees.com"],
  [/\bdel taco\b/, "deltaco.com"],
  [/\braising cane[' ]?s\b/, "raisingcanes.com"],
  [/\bpanera\b/, "panera.com"],
  [/\bpopeyes\b/, "popeyes.com"],
  [/\bkfc\b/, "kfc.com"],
  [/\bdairy queen\b/, "dairyqueen.com"],
  [/\bsonic drive\b/, "sonicdrivein.com"],
  [/\bolive garden\b/, "olivegarden.com"],
  [/\bapplebee[' ]?s\b/, "applebees.com"],
  [/\bcracker barrel\b/, "crackerbarrel.com"],
  [/\bihop\b/, "ihop.com"],
  [/\bdenny[' ]?s\b/, "dennys.com"],
  [/\bchili[' ]?s\b/, "chilis.com"],
  [/\bbuffalo wild wings\b/, "buffalowildwings.com"],
  [/\bpanda express\b/, "pandaexpress.com"],
  [/\bcosta vida\b/, "costavida.com"],
  [/\barctic circle\b/, "arcticcircle.com"],
  [/\bdoor ?dash\b/, "doordash.com"],
  [/\bgrubhub\b/, "grubhub.com"],
  [/\buber eats\b/, "ubereats.com"],
  [/\binstacart\b/, "instacart.com"],
  [/\bshipt\b/, "shipt.com"],

  // Gas / Auto
  [/\bshell\b/, "shell.com"],
  [/\bchevron\b/, "chevron.com"],
  [/\bexxon\b/, "exxon.com"],
  [/\bmobil\b/, "mobil.com"],
  [/\bvalero\b/, "valero.com"],
  [/\bmarathon\b(?! health| mara)/, "marathonbrand.com"],
  [/\bcircle k\b/, "circlek.com"],
  [/\b7-?eleven\b/, "7-eleven.com"],
  [/\bwawa\b/, "wawa.com"],
  [/\bquick ?trip\b/, "quiktrip.com"],
  [/\bpilot travel\b/, "pilotflyingj.com"],
  [/\bflying j\b/, "pilotflyingj.com"],
  [/\bautozone\b/, "autozone.com"],
  [/\bo[' ]?reilly auto\b/, "oreillyauto.com"],
  [/\badvance auto\b/, "advanceautoparts.com"],
  [/\bnapa auto\b/, "napaonline.com"],
  [/\bjiffy lube\b/, "jiffylube.com"],
  [/\bfirestone\b/, "firestonecompleteautocare.com"],
  [/\bpep boys\b/, "pepboys.com"],

  // Travel / Ride-share
  [/\buber\b/, "uber.com"],
  [/\blyft\b/, "lyft.com"],
  [/\bairbnb\b/, "airbnb.com"],
  [/\bexpedia\b/, "expedia.com"],
  [/\bpriceline\b/, "priceline.com"],
  [/\bbooking\.com\b/, "booking.com"],
  [/\bhotels\.com\b/, "hotels.com"],
  [/\bdelta\b(?= airlines| air)/, "delta.com"],
  [/\bunited airlines\b/, "united.com"],
  [/\bsouthwest airlines\b/, "southwest.com"],
  [/\bamerican airlines\b/, "aa.com"],
  [/\bspirit airlines\b/, "spirit.com"],
  [/\bfrontier airlines\b/, "flyfrontier.com"],

  // Streaming / Entertainment
  [/\bnetflix\b/, "netflix.com"],
  [/\bhulu\b/, "hulu.com"],
  // (?:\+|...) not a trailing \b after the whole group — \b can never match
  // right after a literal "+" (a non-word character followed by end-of-
  // string or another non-word character never has a boundary there), so
  // wrapping this in one \b(?:disney\+|disney plus)\b like the fix below
  // makes it look correct actually breaks the "+" branch outright, caught
  // directly by its own regression test (2026-09-14).
  [/\bdisney(?:\+| plus\b)/, "disneyplus.com"],
  [/\bdisney\b/, "disney.com"],
  [/\bhbo\b/, "hbo.com"],
  [/\bspotify\b/, "spotify.com"],
  [/\bapple music\b/, "apple.com"],
  [/\bapple tv\+?\b/, "apple.com"],
  [/\bapple\b/, "apple.com"],
  [/\byoutube\b/, "youtube.com"],
  // Same "+" -vs- trailing \b shape as disney above.
  [/\bparamount(?:\+| plus\b)/, "paramountplus.com"],
  [/\bpeacock\b/, "peacocktv.com"],
  [/\bdiscovery(?:\+| plus\b)/, "discoveryplus.com"],
  [/\btwitch\b/, "twitch.tv"],
  [/\bsteam\b/, "store.steampowered.com"],
  [/\bplaystation\b/, "playstation.com"],
  [/\bxbox\b/, "xbox.com"],
  [/\bnintendo\b/, "nintendo.com"],
  [/\bepic games\b/, "epicgames.com"],
  [/\bcrunchyroll\b/, "crunchyroll.com"],

  // Telecom / Internet
  [/\bverizon\b/, "verizon.com"],
  [/\bat&t\b/, "att.com"],
  [/\bt-?mobile\b/, "t-mobile.com"],
  [/\bcomcast\b/, "comcast.com"],
  [/\bxfinity\b/, "xfinity.com"],
  [/\bspectrum\b/, "spectrum.com"],
  [/\b(?:centurylink|lumen)\b/, "lumen.com"],
  [/\bcox communications\b/, "cox.com"],

  // Insurance
  [/\bstate farm\b/, "statefarm.com"],
  [/\bgeico\b/, "geico.com"],
  [/\ballstate\b/, "allstate.com"],
  [/\bprogressive\b(?! web)/, "progressive.com"],
  [/\bfarmers insurance\b/, "farmers.com"],
  [/\busaa\b/, "usaa.com"],
  [/\bliberty mutual\b/, "libertymutual.com"],
  [/\bnationwide\b/, "nationwide.com"],
  [/\btravelers\b/, "travelers.com"],
  [/\baetna\b/, "aetna.com"],
  [/\bhumana\b/, "humana.com"],
  [/\banthem\b/, "anthem.com"],
  [/\bcigna\b/, "cigna.com"],
  [/\bblue cross\b/, "bcbs.com"],
  [/\bkaiser\b/, "kp.org"],

  // Finance / Banking
  [/\bchase\b/, "chase.com"],
  [/\bbank of america\b/, "bankofamerica.com"],
  [/\bwells fargo\b/, "wellsfargo.com"],
  [/\bcitibank\b/, "citi.com"],
  [/\bpnc bank\b/, "pnc.com"],
  [/\bus bank\b/, "usbank.com"],
  [/\btd bank\b/, "td.com"],
  [/\bcapital one\b/, "capitalone.com"],
  [/\b(?:american express|amex)\b/, "americanexpress.com"],
  // Bare "discover", not just "discover card" — a household's own renamed
  // account (Account.displayName) very often drops "Card" entirely (real
  // report, 2026-09-14: "Discover it (4417)" — Discover's own product
  // name, "Discover it" — matched nothing). Still can't false-positive
  // against Discovery+/Discovery Channel: \b requires a boundary right
  // after "discover," and "discovery" has "y" immediately following with
  // no boundary there.
  [/\bdiscover\b/, "discover.com"],
  [/\bbest egg\b/, "bestegg.com"],
  [/\bsynchrony\b/, "synchrony.com"],
  [/\bpaypal\b/, "paypal.com"],
  [/\bvenmo\b/, "venmo.com"],
  [/\bzelle\b/, "zellepay.com"],
  [/\bcash ?app\b/, "cash.app"],
  [/\bklarna\b/, "klarna.com"],
  [/\baff?irm\b/, "affirm.com"],
  [/\bafter ?pay\b/, "afterpay.com"],
  [/\bsezzle\b/, "sezzle.com"],

  // Software / SaaS
  [/\bgoogle\b/, "google.com"],
  [/\bmicrosoft\b/, "microsoft.com"],
  [/\badobe\b/, "adobe.com"],
  [/\bdropbox\b/, "dropbox.com"],
  [/\bslack\b/, "slack.com"],
  [/\bnotion\b/, "notion.so"],
  [/\bfigma\b/, "figma.com"],
  [/\bzoom\b/, "zoom.us"],
  [/\bgithub\b/, "github.com"],
  [/\blinkedin\b/, "linkedin.com"],
  [/\bcanva\b/, "canva.com"],
  [/\bshopify\b/, "shopify.com"],
  [/\bsquarespace\b/, "squarespace.com"],
  [/\bwix\b/, "wix.com"],
  [/\bmailchimp\b/, "mailchimp.com"],
  [/\bhubspot\b/, "hubspot.com"],
  [/\bsalesforce\b/, "salesforce.com"],
  [/\bquickbooks\b/, "quickbooks.intuit.com"],
  [/\bturbotax\b/, "turbotax.intuit.com"],
  [/\bynab\b/, "youneedabudget.com"],
  [/\bchime\b/, "chime.com"],
  [/\bnordvpn\b/, "nordvpn.com"],
  [/\bexpressvpn\b/, "expressvpn.com"],
  [/\b1password\b/, "1password.com"],
  [/\blastpass\b/, "lastpass.com"],
  [/\bnorton\b/, "norton.com"],
  [/\bmalwarebytes\b/, "malwarebytes.com"],

  // Health / Fitness / Pharmacy
  [/\bplanet fitness\b/, "planetfitness.com"],
  [/\bla fitness\b/, "lafitness.com"],
  [/\bpeloton\b/, "onepeloton.com"],
  [/\bnike\b/, "nike.com"],
  [/\badidas\b/, "adidas.com"],
  [/\bpuma\b/, "puma.com"],
  [/\bcvs\b/, "cvs.com"],
  [/\bwalgreens\b/, "walgreens.com"],
  [/\brite aid\b/, "riteaid.com"],

  // Home / Furniture / Services
  [/\bikea\b/, "ikea.com"],
  [/\bcrate &? barrel\b/, "crateandbarrel.com"],
  [/\bpottery barn\b/, "potterybarn.com"],
  [/\bwest elm\b/, "westelm.com"],
  [/\bwilliams ?-? ?sonoma\b/, "williams-sonoma.com"],
  [/\bbath &? ?body works\b/, "bathandbodyworks.com"],
  [/\bpetsmart\b/, "petsmart.com"],
  [/\bpetco\b/, "petco.com"],

  // Shipping
  [/\bups\b/, "ups.com"],
  [/\bfedex\b/, "fedex.com"],
  [/\busps\b/, "usps.com"],
  [/\bdhl\b/, "dhl.com"],

  // Education
  [/\bcoursera\b/, "coursera.org"],
  [/\budemy\b/, "udemy.com"],
  [/\bskillshare\b/, "skillshare.com"],
  [/\bduolingo\b/, "duolingo.com"],

  // Link.com / generic domain-like names
  [/\blink\.com\b/, "link.com"],
];

/** Curated exact-match lookup only — zero network cost, no guessing. */
export function getCuratedDomain(merchant: string): string | null {
  return getCuratedDomains(merchant, 1)[0] ?? null;
}

/**
 * Every distinct curated domain the merchant string matches, in table
 * order, capped at `max` — for a composite name like "Nike - Klarna" (a
 * BNPL debt's household-chosen retailer + provider label), this returns
 * both nike.com and klarna.com regardless of which word comes first
 * ("Klarna - Nike" matches the same two patterns) so the household doesn't
 * have to pick one ordering to get both logos (2026-09-13 household
 * request). Single-match merchants (the overwhelming common case) just get
 * a one-element array, same as getCuratedDomain always did.
 */
export function getCuratedDomains(merchant: string, max = 2): string[] {
  // Every possessive-brand pattern below (Sam's Club, Kohl's, McDonald's,
  // Trader Joe's, ...) only ever tests for a *straight* apostrophe (' ,
  // U+0027) — but a name a household typed themselves (an account
  // displayName override, most notably) very often carries a *curly* one
  // (' , U+2019) instead, since iOS auto-converts straight quotes to curly
  // ones in text fields by default. Real report, 2026-09-14: "Sam's Club
  // Card" (household-renamed account, curly apostrophe confirmed directly
  // against the stored value) matched nothing. Normalizing both curly
  // quote marks to the plain straight one before testing fixes every
  // apostrophe-containing pattern at once, not just this one.
  const m = merchant.toLowerCase().replace(/[‘’]/g, "'");
  const domains: string[] = [];
  for (const [pattern, domain] of MERCHANT_DOMAINS) {
    if (domain && pattern.test(m) && !domains.includes(domain)) {
      domains.push(domain);
      if (domains.length >= max) break;
    }
  }
  return domains;
}

/**
 * Given a merchant name string, returns the Hunter.io logo URL for it, or
 * null if no curated domain mapping is found. Curated-table-only — callers
 * that also want the DB-cached guessed-and-verified fallback should use
 * MerchantLogo's `allowGuess` prop instead of calling this directly.
 */
export function getMerchantLogoUrl(merchant: string): string | null {
  const domain = getCuratedDomain(merchant);
  return domain ? `https://logos.hunter.io/${domain}` : null;
}

/**
 * The text to actually search for a debt's brand logo — its own displayed
 * name plus, when that alone finds nothing, the raw synced account name
 * underneath it (a household renaming a synced account, Account.
 * displayName, can drop the one word a curated pattern needed: "Venture
 * (3021)" alone matches nothing, but the raw synced Account.name is the
 * same "Venture (3021)" either way, so that alone doesn't help here — see
 * accountOrgName below for how "Capital One Venture" actually gets found).
 *
 * accountOrgName (Account.orgName, SimpleFIN's own "which institution"
 * field) is a last-resort tier, only appended when *neither* the displayed
 * name nor the raw account name alone resolved anything — it's what
 * supplies "Capital One" for the Venture card (its raw synced name alone
 * has never had the brand in it). Deliberately not folded in
 * unconditionally: orgName isn't reliably accurate — a real household's
 * Discover it card reports orgName "Capital One" despite its own raw
 * synced name already correctly saying "Discover it," and searching
 * orgName unconditionally alongside it surfaced a false second brand icon
 * next to the real one (household report, 2026-09-14: "revert the double
 * brand icon... go back to basing it off simplefin sync merchant or raw
 * one"). Tiering it behind "did the reliable text already find something"
 * gets both cards right: Discover it resolves from its own raw name alone
 * and never reaches orgName; Capital One Venture finds nothing until it
 * does.
 *
 * Only ever used for logo matching — the displayed text itself stays
 * exactly the household's own chosen name.
 */
export function debtLogoSearchText(
  debtName: string,
  accountRawName: string | null,
  accountOrgName: string | null,
): string {
  const withRawName = accountRawName && accountRawName !== debtName ? `${debtName} ${accountRawName}` : debtName;
  if (getCuratedDomains(withRawName, 1).length > 0) return withRawName;
  return accountOrgName ? `${withRawName} ${accountOrgName}` : withRawName;
}

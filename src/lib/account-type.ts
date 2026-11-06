import type { AccountType } from "@prisma/client";
import type { SimpleFinAccount } from "@/lib/simplefin";

// Card issuers whose retail product names (Quicksilver, Venture, Sapphire,
// Freedom...) don't contain any generic "credit card" keyword — there's no
// exhaustive list of every product name, but the issuer list is short and
// stable, so anything from one of these that isn't already a loan/
// investment/deposit account is almost certainly a card.
const KNOWN_CARD_ISSUERS = [
  "capital one",
  "chase",
  "discover",
  "american express",
  "amex",
  "citi",
  "barclays",
  "wells fargo",
  "bank of america",
  "us bank",
  "synchrony",
];

// Same idea for installment lenders that only ever issue loans — SimpleFIN
// often reports these with the bare brand as the account name (a personal
// loan synced as just the lender's name, 2026-11-06), so neither keyword
// check below ever fires and the account fell into OTHER.
const KNOWN_LOAN_LENDERS = ["best egg", "lending club", "lendingclub", "sofi", "upstart", "prosper", "avant"];

// Home-equity lines and other credit lines are debts too, but their product
// names rarely say "loan" (e.g. "Fixed Rate Heloc 5", 2026-11-06).
const LOAN_KEYWORDS = ["loan", "mortgage", "heloc", "home equity", "line of credit"];

export function guessAccountType(a: SimpleFinAccount): AccountType {
  const name = `${a.name} ${a.org?.name ?? ""}`.toLowerCase();
  const orgName = (a.org?.name ?? "").toLowerCase();
  if (name.includes("credit card") || name.includes("visa") || name.includes("mastercard")) return "CREDIT_CARD";
  if (LOAN_KEYWORDS.some((k) => name.includes(k))) return "LOAN";
  if (
    name.includes("401k") ||
    name.includes("401(k)") ||
    name.includes(" ira") ||
    name.includes("roth") ||
    name.includes("brokerage") ||
    name.includes("investment") ||
    name.includes("retirement")
  ) {
    return "INVESTMENT";
  }
  // Money market (savings-style, check-writing privileges but still a
  // liquid deposit account) doesn't contain "saving" or "checking" in most
  // banks' product names, so it needs its own keyword — grouped under
  // SAVINGS since that's what it behaves like for net worth/cash purposes.
  if (name.includes("saving") || name.includes("money market")) return "SAVINGS";
  if (name.includes("checking")) return "CHECKING";
  if (KNOWN_CARD_ISSUERS.some((issuer) => orgName.includes(issuer))) return "CREDIT_CARD";
  if (KNOWN_LOAN_LENDERS.some((lender) => orgName.includes(lender))) return "LOAN";
  return "OTHER";
}

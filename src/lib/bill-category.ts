// Seeded once for every household (migration backfill + registerHousehold)
// so the category picker isn't empty on day one — but from then on these
// are just regular rows a household can rename, delete, or add alongside,
// same as anything else in BillCategory. Not a fixed enum.
export const DEFAULT_BILL_CATEGORY_NAMES = [
  "Mortgage/Rent",
  "Utilities",
  "Insurance",
  "Loan payment",
  "Subscription",
  "Other",
];

// Best-effort default *label* for a newly-detected bill suggestion — always
// a starting point the household confirms or changes before tracking, never
// auto-applied to an already-tracked bill. The caller resolves this label
// against the household's actual category list (which may have renamed or
// deleted any of the defaults) and falls back sensibly if nothing matches.
// Keyword-based on purpose: this runs client-side with zero cost per
// suggestion shown, unlike the Gemini bucket-guessing pipeline, which is
// metered (see WORKING_ON.md's Gemini quota note) and reserved for the
// harder "which spending bucket" call.
export function guessBillCategoryLabel(merchant: string): string {
  const m = merchant.toLowerCase();
  if (/mortgage|\brent\b|\bhoa\b|residential/.test(m)) return "Mortgage/Rent";
  if (/insurance|\bmutual\b|allstate|geico|state farm|progressive|farmers/.test(m)) return "Insurance";
  if (
    /power|electric|\bwater\b|\bgas\b|energy|utilit|irrigat|sewer|waste ?management|internet|\bisp\b|verizon|at&t|t-?mobile|comcast|xfinity|centurylink|spectrum/.test(
      m,
    )
  )
    return "Utilities";
  if (/\bloan\b|financ|auto pay|credit union|leas(e|ing)|credit card/.test(m)) return "Loan payment";
  if (
    /netflix|hulu|spotify|apple|google (one|play)|amazon prime|disney|hbo|paramount|peacock|subscription|membership|gym|fitness/.test(
      m,
    )
  )
    return "Subscription";
  return "Other";
}

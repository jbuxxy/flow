import type { Prisma } from "@prisma/client";

// Every field that says what a transaction IS (spend in a bucket, a debt
// payment, income, a bill or pattern payment), cleared. A transaction's
// classification is mutually exclusive, so every action that re-files one
// spreads this first and then sets only its new classification's own
// fields — the "Track as income / bill / debt payment" actions each used to
// clear a hand-picked subset and leave stale links behind (a leftover
// debtPaymentId kept a minimum "paid" and double-counted the money as both
// debt spend and income; 2026-10-08 review).
export const CLEARED_CLASSIFICATION = {
  bucketId: null,
  categoryId: null,
  aiSuggestedBucketId: null,
  aiSuggestedCategoryId: null,
  debtId: null,
  debtPaymentId: null,
  isTransfer: false,
  isIncome: false,
  incomeId: null,
  billId: null,
  patternId: null,
} satisfies Prisma.TransactionUncheckedUpdateInput;

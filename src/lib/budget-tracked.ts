import type { Prisma } from "@prisma/client";

// A non-budget-tracked account's spend (see Account.budgetTracked) was
// never auto-filed toward a bucket in the first place — nagging to manually
// pick one, counting it toward spend, or including it in bucket composition
// would each be asking for something the household explicitly opted out of.
// Shared by buckets.ts's "Needs a bucket" queue, the /transactions "Budget
// accounts only" filter, refund-match.ts, spend.ts's trend/ceiling queries,
// and bucket-composition.ts's merchant-breakdown query — same OR clause,
// same reasoning, everywhere. Kept in its own leaf module (not buckets.ts,
// which spend.ts already imports) purely to avoid an import cycle — this
// used to be reimplemented three separate ways (see WORKING_ON.md) as each
// new caller ran into that cycle and just inlined the clause instead of
// noticing the other inline copies.
export function budgetTrackedWhere(): Prisma.TransactionWhereInput {
  return { OR: [{ accountId: null }, { account: { budgetTracked: true } }] };
}

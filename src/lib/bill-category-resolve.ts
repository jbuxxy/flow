import { db } from "@/lib/db";

// Lives outside bills/actions.ts on purpose: every export of a server-actions
// file is a publicly POST-able endpoint, and this one takes a caller-supplied
// householdId with no session check of its own — exported from there, anyone
// could probe category ids against any household (2026-10-05 review).
// Callers pass their own session's householdId.
//
// bucketId, when passed, additionally requires the category to belong to
// that specific bucket (see the schema comment on BillCategory.bucketId) —
// omit it only for a context with no bucket to scope by at all (a CREDIT
// income/reimbursement RecurringPattern, or a debt-targeted one), never
// because the caller happens to already have a bucketId in scope and just
// didn't bother passing it.
export async function resolveCategoryId(
  householdId: string,
  categoryId?: string | null,
  bucketId?: string | null,
): Promise<string | null> {
  if (!categoryId) return null;
  const category = await db.billCategory.findUnique({ where: { id: categoryId } });
  if (!category || category.householdId !== householdId) return null;
  if (bucketId !== undefined && category.bucketId !== bucketId) return null;
  return category.id;
}

import { db } from "@/lib/db";
import { suggestBucketIcons } from "@/lib/ai";
import { BUCKET_ICON_KEYS, keywordIconKey } from "@/lib/bucket-icons";
import { isDemoHousehold } from "@/lib/demo";

// Fills in Bucket.icon for every bucket whose name matches none of the
// keyword rules and doesn't already have one stored — one batched AI call,
// skipped entirely when every bucket is already resolved (the steady
// state). Called from the bucket list and detail pages on load; safe to
// call on every render since it short-circuits with no DB write and no AI
// call once there's nothing left to resolve. Never throws — an AI failure
// just leaves the bucket on its Wallet fallback until next time.
export async function ensureBucketIcons(householdId: string): Promise<void> {
  if (await isDemoHousehold(householdId)) return; // frozen — see src/lib/demo.ts
  const candidates = await db.bucket.findMany({
    where: { householdId, icon: null },
    select: { id: true, name: true },
  });
  const unresolved = candidates.filter((b) => keywordIconKey(b.name) === null);
  if (unresolved.length === 0) return;

  try {
    const picks = await suggestBucketIcons(
      householdId,
      unresolved.map((b) => b.name),
      BUCKET_ICON_KEYS,
    );
    await Promise.all(
      unresolved.map((b) => {
        const key = picks.get(b.name);
        if (!key) return null;
        return db.bucket.update({ where: { id: b.id }, data: { icon: key } });
      }),
    );
  } catch {
    // Leave unresolved buckets as-is — they render the Wallet fallback and
    // get retried on the next page load.
  }
}

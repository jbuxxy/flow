import { after } from "next/server";
import { db } from "@/lib/db";
import { suggestBucketIcons } from "@/lib/ai";
import { BUCKET_ICON_KEYS, keywordIconKey } from "@/lib/bucket-icons";
import { isDemoHousehold } from "@/lib/demo";

// Fills in Bucket.icon for every bucket whose name matches none of the
// keyword rules and doesn't already have one stored — one batched AI call,
// skipped entirely when every bucket is already resolved (the steady state).
// Never throws — an AI failure just leaves the bucket on its Wallet fallback.
//
// Not on the render path: pages schedule it with after() (scheduleBucketIcons
// below) and bucket create/rename actions do the same, so a page never waits
// on an AI call — a fresh icon shows from the next load. A household whose
// AI pick failed (or came back empty) isn't retried for RETRY_AFTER_MS,
// instead of re-calling the AI on every single page load (2026-10-09 review).
const RETRY_AFTER_MS = 60 * 60 * 1000;
const g = globalThis as unknown as { __flowBucketIconAttempts?: Map<string, number> };
const lastAttemptByHousehold = (g.__flowBucketIconAttempts ??= new Map());

export async function ensureBucketIcons(householdId: string): Promise<void> {
  if (await isDemoHousehold(householdId)) return; // frozen — see src/lib/demo.ts
  const candidates = await db.bucket.findMany({
    where: { householdId, icon: null },
    select: { id: true, name: true },
  });
  const unresolved = candidates.filter((b) => keywordIconKey(b.name) === null);
  if (unresolved.length === 0) return;
  const lastAttempt = lastAttemptByHousehold.get(householdId);
  if (lastAttempt !== undefined && Date.now() - lastAttempt < RETRY_AFTER_MS) return;
  lastAttemptByHousehold.set(householdId, Date.now());

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
    // Every pick landed — a later new/renamed bucket shouldn't wait out the
    // backoff.
    if (unresolved.every((b) => picks.get(b.name))) lastAttemptByHousehold.delete(householdId);
  } catch {
    // Leave unresolved buckets as-is — they render the Wallet fallback and
    // get retried once the backoff passes.
  }
}

// The non-blocking form for pages and actions: runs once the response has
// been sent. A bucket created or renamed by hand clears the backoff first —
// that's a new name the AI hasn't been asked about yet.
export function scheduleBucketIcons(householdId: string, opts: { newName?: boolean } = {}): void {
  if (opts.newName) lastAttemptByHousehold.delete(householdId);
  after(() => ensureBucketIcons(householdId));
}

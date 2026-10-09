"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { requireOwned, requireOwner } from "@/lib/access";
import { parseDollarsToCents } from "@/lib/money";
import type { BucketAlertOverrideValue } from "@prisma/client";

// A misclassified transaction gets fixed by reclassifying
// (reassignTransaction) or marked reviewed-but-not-spend, never by deleting
// the record of it happening — every transaction is real synced bank
// history (manual entry was removed 2026-08-15), so there's no
// delete-transaction action at all.

const updateBucketSchema = z.object({
  bucketId: z.string(),
  name: z.string().trim().min(1).max(60),
  monthlyCap: z.string(),
  warningThresholdPct: z.coerce.number().int().min(1).max(100),
  paceAlertEnabled: z.enum(["on"]).optional(),
  weeklyReportEnabled: z.enum(["on"]).optional(),
  transactionAlertEnabled: z.enum(["on"]).optional(),
  trackingMode: z.enum(["SPEND", "RECURRING", "MIXED"]),
  excludedFromAllocation: z.enum(["on"]).optional(),
  aiInstructions: z.string().trim().max(500).optional(),
});

export type UpdateBucketState = { error?: string };

export async function updateBucketSettings(
  _prev: UpdateBucketState,
  formData: FormData,
): Promise<UpdateBucketState> {
  const session = await auth();
  if (!session?.user) redirect("/login");

  const parsed = updateBucketSchema.safeParse({
    bucketId: formData.get("bucketId"),
    name: formData.get("name"),
    monthlyCap: formData.get("monthlyCap"),
    warningThresholdPct: formData.get("warningThresholdPct"),
    paceAlertEnabled: formData.get("paceAlertEnabled") ?? undefined,
    weeklyReportEnabled: formData.get("weeklyReportEnabled") ?? undefined,
    transactionAlertEnabled: formData.get("transactionAlertEnabled") ?? undefined,
    trackingMode: formData.get("trackingMode"),
    excludedFromAllocation: formData.get("excludedFromAllocation") ?? undefined,
    aiInstructions: formData.get("aiInstructions") ?? undefined,
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  const bucket = await requireOwned(
    db.bucket.findUnique({ where: { id: parsed.data.bucketId } }),
    session.user.householdId,
  );

  const cents = parseDollarsToCents(parsed.data.monthlyCap);
  if (cents === null) {
    return { error: "Enter a valid budget amount." };
  }

  // Name/type/cap/threshold are owner-only (household request, 2026-09-12) —
  // the form disables those fields for a non-owner and passes their current
  // values through unchanged (bucket-settings-form.tsx), but that's a UI
  // nicety, not the real boundary: silently keep the bucket's existing
  // values here regardless of what the submit actually carried, so a
  // tampered request can't touch them either. Alerts/AI Assist stay open to
  // every member — this only narrows the four fields that were named.
  const isOwner = session.user.role === "OWNER";
  // A member whose notifications an owner has locked (User.notificationsLocked)
  // can't change any notification setting, bucket alerts included (household
  // rule, 2026-10-03) — keep the bucket's existing alert flags for them.
  const alertsLocked =
    !isOwner &&
    !!(await db.user.findUnique({ where: { id: session.user.id }, select: { notificationsLocked: true } }))
      ?.notificationsLocked;

  await db.bucket.update({
    where: { id: bucket.id },
    data: {
      name: isOwner ? parsed.data.name : bucket.name,
      monthlyCapCents: isOwner ? cents : bucket.monthlyCapCents,
      warningThresholdPct: isOwner ? parsed.data.warningThresholdPct : bucket.warningThresholdPct,
      paceAlertEnabled: alertsLocked ? bucket.paceAlertEnabled : parsed.data.paceAlertEnabled === "on",
      weeklyReportEnabled: alertsLocked ? bucket.weeklyReportEnabled : parsed.data.weeklyReportEnabled === "on",
      transactionAlertEnabled: alertsLocked
        ? bucket.transactionAlertEnabled
        : parsed.data.transactionAlertEnabled === "on",
      trackingMode: isOwner ? parsed.data.trackingMode : bucket.trackingMode,
      excludedFromAllocation: isOwner ? parsed.data.excludedFromAllocation === "on" : bucket.excludedFromAllocation,
      aiInstructions: parsed.data.aiInstructions || null,
      // Renamed → drop the cached icon so ensureBucketIcons re-resolves it
      // (keyword rule first, AI only if the new name still misses).
      ...(isOwner && parsed.data.name !== bucket.name ? { icon: null } : {}),
    },
  });

  revalidatePath(`/buckets/${bucket.id}`);
  revalidatePath("/buckets");
  return {};
}

const bucketOverrideValues = ["ALWAYS", "NEVER", "DEFAULT"] as const;

export type BucketAlertOverrideChoice = (typeof bucketOverrideValues)[number];

// The only bucket alert types Bucket Settings itself exposes an owner-facing
// on/off checkbox for (paceAlertEnabled/weeklyReportEnabled/
// transactionAlertEnabled) — the per-user lock only ever applies to one of
// these three. BUCKET_WARNING/EXCEEDED/BUCKET_TOPPED_UP have no bucket-wide
// checkbox to begin with and stay on the plain household-wide default for
// every recipient; nothing stops a future UI from adding them here too, but
// nobody's asked for it.
//
// Not exported as a value — a "use server" file can only export async
// functions (real production error, 2026-09-12: exporting this array here
// broke every action in the file, including the unrelated ones, with "A
// 'use server' file can only export async functions, found object"). Only
// the derived *type* below needs to reach other files; the runtime array
// itself is only ever read inside this module.
const bucketAlertOverrideTypes = ["BUCKET_PACE", "WEEKLY_BUCKET_REPORT", "BUCKET_TRANSACTION"] as const;
export type BucketAlertOverrideType = (typeof bucketAlertOverrideTypes)[number];

// Owner-only — this decides what OTHER household members receive, not a
// personal preference like NotificationPreference (which anyone sets for
// themselves). ALWAYS/NEVER force that member in or out of this one alert
// type on this one bucket, overriding their own global NotificationPreference
// for just that combination — every other bucket, and every other alert
// type on this same bucket, still follows their own choice. From the
// affected member's own side, this reads as "locked": bucket-settings-form.tsx
// renders their checkbox for that alert type disabled, with a lock icon,
// checked/unchecked to match whichever state it's locked to (household
// request, 2026-09-12). DEFAULT removes the override (deletes the row —
// see BucketAlertOverride's own schema comment for why DEFAULT is never
// stored). See sendPushToBucketForType (push.ts) for how the two layers combine.
export async function setBucketAlertOverride(
  bucketId: string,
  userId: string,
  type: BucketAlertOverrideType,
  choice: BucketAlertOverrideChoice,
): Promise<void> {
  const session = await requireOwner();

  // A server action is directly callable — TypeScript's own param types are
  // a compile-time-only guarantee, not enforced against a request built by
  // hand. Re-check both enums at runtime before touching the DB.
  if (!bucketAlertOverrideTypes.includes(type)) return;
  if (!bucketOverrideValues.includes(choice)) return;

  await requireOwned(db.bucket.findUnique({ where: { id: bucketId } }), session.user.householdId);
  const member = await requireOwned(db.user.findUnique({ where: { id: userId } }), session.user.householdId);

  if (choice === "DEFAULT") {
    await db.bucketAlertOverride.deleteMany({ where: { bucketId, userId: member.id, type } });
  } else {
    await db.bucketAlertOverride.upsert({
      where: { bucketId_userId_type: { bucketId, userId: member.id, type } },
      create: { bucketId, userId: member.id, type, override: choice as BucketAlertOverrideValue },
      update: { override: choice as BucketAlertOverrideValue },
    });
  }

  revalidatePath(`/buckets/${bucketId}`);
}

// Owner-only, same as renaming or changing a bucket's cap/type
// (updateBucketSettings) — this used to check only household ownership, so a
// Basic Access member could delete any bucket (2026-10-08 review).
export async function deleteBucket(bucketId: string) {
  const session = await requireOwner();

  const bucket = await requireOwned(db.bucket.findUnique({ where: { id: bucketId } }), session.user.householdId);
  // Transactions survive (Transaction.bucket is onDelete: SetNull) and fall
  // back to Needs a Bucket — clear their category too, since this bucket's
  // categories go bucketless and a category only means something inside
  // its bucket.
  await db.$transaction([
    db.transaction.updateMany({ where: { bucketId: bucket.id }, data: { categoryId: null } }),
    db.bucket.delete({ where: { id: bucket.id } }),
  ]);

  revalidatePath("/buckets");
  redirect("/buckets");
}

import webpush from "web-push";
import type { NotificationType } from "@prisma/client";
import { db } from "@/lib/db";
import { defaultNotificationEnabled } from "@/lib/notification-preferences";

let configured = false;
function ensureConfigured() {
  if (configured) return;
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  if (!publicKey || !privateKey) {
    throw new Error("VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY are not set");
  }
  const subject = process.env.VAPID_SUBJECT || "mailto:admin@example.com";
  webpush.setVapidDetails(subject, publicKey, privateKey);
  configured = true;
}

export type PushPayload = {
  title: string;
  body: string;
  url?: string;
};

// Sends to every subscription for a user; prunes subscriptions the push
// service reports as gone (410/404) instead of retrying them forever.
export async function sendPushToUser(userId: string, payload: PushPayload) {
  ensureConfigured();

  // The account-level master switch (User.notificationsEnabled) — every push
  // in the app funnels through here, so this one check covers all of them.
  const user = await db.user.findUnique({ where: { id: userId }, select: { notificationsEnabled: true } });
  if (!user?.notificationsEnabled) return;

  const subscriptions = await db.pushSubscription.findMany({ where: { userId } });
  const json = JSON.stringify(payload);

  await Promise.all(
    subscriptions.map(async (sub) => {
      try {
        await webpush.sendNotification(
          {
            endpoint: sub.endpoint,
            keys: { p256dh: sub.p256dh, auth: sub.auth },
          },
          json,
        );
      } catch (err) {
        const statusCode = (err as { statusCode?: number }).statusCode;
        if (statusCode === 404 || statusCode === 410) {
          await db.pushSubscription.delete({ where: { id: sub.id } }).catch(() => {});
        } else {
          console.error(`[push] send failed for subscription ${sub.id}:`, err);
        }
      }
    }),
  );
}

type PrefCheckedUser = { id: string; role: string; dashboardScope: string };

// Filters `users` down to whoever's own NotificationPreference for `type` is
// on — explicit choice if they've made one, defaultNotificationEnabled's
// role-aware default otherwise. Shared by every "who gets this push" reader
// below so a future change to how a missing preference row defaults only
// has to happen in one place — sendPushToHouseholdForType and
// sendPushToBucketForType used to each carry their own copy of this exact
// fetch+filter (2026-09-14 code review).
async function filterByNotificationPreference<T extends PrefCheckedUser>(
  users: T[],
  type: NotificationType,
): Promise<T[]> {
  if (users.length === 0) return [];
  const prefs = await db.notificationPreference.findMany({
    where: { userId: { in: users.map((u) => u.id) }, type },
    select: { userId: true, enabled: true },
  });
  const prefByUser = new Map(prefs.map((p) => [p.userId, p.enabled]));
  return users.filter((u) => prefByUser.get(u.id) ?? defaultNotificationEnabled(u, type));
}

// Every household member, minus anyone who's opted out of this
// NotificationType — see defaultNotificationEnabled for what "no explicit
// choice yet" resolves to per recipient.
export async function sendPushToHouseholdForType(
  householdId: string,
  type: NotificationType,
  payload: PushPayload,
) {
  const users = await db.user.findMany({
    where: { householdId },
    select: { id: true, role: true, dashboardScope: true },
  });
  const recipients = await filterByNotificationPreference(users, type);
  await Promise.all(recipients.map((u) => sendPushToUser(u.id, payload)));
}

// The bucket-scoped counterpart to sendPushToHouseholdForType — every push
// a specific bucket can send (BUCKET_WARNING/EXCEEDED/PACE/TRANSACTION,
// WEEKLY_BUCKET_REPORT, BUCKET_TOPPED_UP) goes through this instead, so an
// owner's per-bucket-and-type BucketAlertOverride (buckets/[id]/actions.ts)
// is honored on top of each recipient's own global NotificationPreference.
// ALWAYS/NEVER here wins outright, in either direction — including forcing
// a push to someone who's turned this exact NotificationType off for
// themselves everywhere else (household request, 2026-09-12: "so if a user
// turns it off... I can override that as owner and turn it on for them").
// No override row for this (bucket, user, type) — the default for anything
// nobody's customized — falls through to exactly the same global-preference
// check sendPushToHouseholdForType does.
export async function sendPushToBucketForType(
  bucketId: string,
  householdId: string,
  type: NotificationType,
  payload: PushPayload,
) {
  const [users, overrides] = await Promise.all([
    db.user.findMany({ where: { householdId }, select: { id: true, role: true, dashboardScope: true } }),
    // Scoped to this exact (bucket, type) — an override on this bucket's
    // WEEKLY_BUCKET_REPORT says nothing about its BUCKET_PACE.
    db.bucketAlertOverride.findMany({ where: { bucketId, type }, select: { userId: true, override: true } }),
  ]);
  const overrideByUser = new Map(overrides.map((o) => [o.userId, o.override]));

  const forcedOn = users.filter((u) => overrideByUser.get(u.id) === "ALWAYS");
  const eligible = users.filter((u) => overrideByUser.get(u.id) === undefined);
  const defaultRecipients = await filterByNotificationPreference(eligible, type);

  const recipients = [...forcedOn, ...defaultRecipients];
  await Promise.all(recipients.map((u) => sendPushToUser(u.id, payload)));
}

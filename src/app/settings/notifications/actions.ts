"use server";

import { revalidatePath } from "next/cache";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import type { NotificationType } from "@prisma/client";

export type UpdatePreferenceResult = { error?: string };

// Self-edit is always allowed; editing someone else's preferences requires
// OWNER. No existing helper in src/lib/access.ts has this shape (those are
// all owner-only or accessible-to-everyone gates), so this is new logic.
export async function updateNotificationPreference(
  targetUserId: string,
  type: NotificationType,
  enabled: boolean,
): Promise<UpdatePreferenceResult> {
  const session = await auth();
  if (!session?.user) return { error: "Not authorized." };

  const isSelf = session.user.id === targetUserId;
  if (!isSelf && session.user.role !== "OWNER") {
    return { error: "Not authorized." };
  }

  const target = await db.user.findUnique({
    where: { id: targetUserId },
    select: { householdId: true, notificationsLocked: true },
  });
  if (!target || target.householdId !== session.user.householdId) {
    return { error: "Not found." };
  }
  // An owner's lock on this member's master switch freezes every one of their
  // notification settings for them — the owner can still change them.
  if (target.notificationsLocked && session.user.role !== "OWNER") {
    return { error: "Locked by the household owner." };
  }

  await db.notificationPreference.upsert({
    where: { userId_type: { userId: targetUserId, type } },
    create: { userId: targetUserId, type, enabled },
    update: { enabled },
  });

  revalidatePath("/settings/notifications");
  return {};
}

// The account-level master switch (User.notificationsEnabled). Self or owner;
// a member can't change their own while an owner has it locked.
export async function setNotificationsEnabled(targetUserId: string, enabled: boolean): Promise<UpdatePreferenceResult> {
  const session = await auth();
  if (!session?.user) return { error: "Not authorized." };
  const isOwner = session.user.role === "OWNER";
  if (session.user.id !== targetUserId && !isOwner) return { error: "Not authorized." };

  const target = await db.user.findUnique({
    where: { id: targetUserId },
    select: { householdId: true, notificationsLocked: true },
  });
  if (!target || target.householdId !== session.user.householdId) return { error: "Not found." };
  if (target.notificationsLocked && !isOwner) return { error: "Locked by the household owner." };

  await db.user.update({ where: { id: targetUserId }, data: { notificationsEnabled: enabled } });
  revalidatePath("/settings/notifications");
  revalidatePath("/settings");
  return {};
}

// Owner-only: lock (or unlock) another member's master switch where it sits.
// The owner's own switch is never lockable — there's no one above them.
export async function setNotificationsLocked(targetUserId: string, locked: boolean): Promise<UpdatePreferenceResult> {
  const session = await auth();
  if (!session?.user || session.user.role !== "OWNER") return { error: "Not authorized." };
  if (session.user.id === targetUserId) return { error: "Your own notifications can't be locked." };

  const target = await db.user.findUnique({ where: { id: targetUserId }, select: { householdId: true } });
  if (!target || target.householdId !== session.user.householdId) return { error: "Not found." };

  await db.user.update({ where: { id: targetUserId }, data: { notificationsLocked: locked } });
  revalidatePath("/settings/notifications");
  revalidatePath("/settings");
  return {};
}

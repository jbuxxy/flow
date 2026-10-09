"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { belongsToHousehold } from "@/lib/access";
import { hashPassword, verifyPassword } from "@/lib/password";
import { generateInviteCode, resolveAppOrigin, INVITE_CODE_TTL_MS } from "@/lib/invite-link";
import { ACCESS_LEVELS, type AccessLevel } from "@/lib/member-access";

const inviteSchema = z.object({
  accessLevel: z.enum(["OWNER", "PARTNER", "BASIC"]),
});

export type InviteState = { error?: string; setupUrl?: string; needsTotp?: boolean };

// Only an access level — no name/email/password. The owner just picks who
// this is FOR in terms of permissions and gets a link back; the invitee
// supplies their own name, email, and password as the setup flow's first
// step (setAccountDetails, src/app/setup-totp/actions.ts) rather than the
// owner filling in someone else's identity/inventing a password for them
// (household request, 2026-09-24). Every access level gets a link,
// including Basic/CHILD: they still go through that same first step even
// though they skip the TOTP step that follows it (see /setup-totp's own
// role check).
export async function inviteHouseholdMember(
  _prev: InviteState,
  formData: FormData,
): Promise<InviteState> {
  const session = await auth();
  // Owner-only — a Partner can see the household's finances but doesn't
  // get to add or edit other members.
  if (!session?.user || session.user.role !== "OWNER") {
    return { error: "Not authorized." };
  }

  const parsed = inviteSchema.safeParse({
    accessLevel: formData.get("accessLevel"),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  const { role, dashboardScope } = ACCESS_LEVELS[parsed.data.accessLevel];

  const inviteCode = generateInviteCode();
  const user = await db.user.create({
    data: {
      householdId: session.user.householdId,
      role,
      dashboardScope,
      inviteCode,
      inviteCodeExpiresAt: new Date(Date.now() + INVITE_CODE_TTL_MS),
    },
  });

  await db.auditLog.create({
    data: {
      userId: session.user.id,
      action: "HOUSEHOLD_MEMBER_INVITED",
      detail: { invitedUserId: user.id, role },
    },
  });

  revalidatePath("/settings/members");

  const base = await resolveAppOrigin();
  return {
    setupUrl: `${base}/invite/${inviteCode}`,
    // From the server-determined role, not the form's own accessLevel state
    // — that resets to its default the moment this success state lands
    // (see useActionToast's onSuccess below), so the form can't reliably
    // read it back at display time.
    needsTotp: role !== "CHILD",
  };
}

// setupUrl: set when this save moved a member who has no authenticator yet
// into a role that requires one (CHILD → Partner/Owner) — see
// issueTwoFactorSetupLink below.
export type UpdateMemberResult = { error?: string; setupUrl?: string };

const updateMemberSchema = z.object({
  name: z.string().trim().min(1).max(80),
  email: z.string().trim().email().max(254).transform((v) => v.toLowerCase()),
  // Blank means "leave the password as-is" — Save shouldn't force re-entering
  // it just to change a name or access level.
  password: z.string().max(200),
  currentPassword: z.string().max(200).optional(),
  confirmPassword: z.string().max(200).optional(),
  accessLevel: z.enum(["OWNER", "PARTNER", "BASIC"]),
});

export async function updateMember(
  userId: string,
  input: {
    name: string;
    email: string;
    password: string;
    currentPassword?: string;
    confirmPassword?: string;
    accessLevel: AccessLevel;
  },
): Promise<UpdateMemberResult> {
  const session = await auth();
  if (!session?.user) redirect("/login");
  if (session.user.role !== "OWNER") return { error: "Not authorized." };

  const parsed = updateMemberSchema.safeParse(input);
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  if (parsed.data.password) {
    if (parsed.data.password.length < 12) {
      return { error: "Password must be at least 12 characters." };
    }
    if (!parsed.data.currentPassword) {
      return { error: "Enter your current password to confirm password change." };
    }
    if (parsed.data.password !== parsed.data.confirmPassword) {
      return { error: "New passwords do not match." };
    }

    const sessionUser = await db.user.findUnique({ where: { id: session.user.id } });
    // Can't happen in practice — a session only exists once its own
    // passwordHash was set (auth.ts's authorize() rejects a null one) — but
    // the schema allows null, so TypeScript needs the explicit guard.
    if (!sessionUser?.passwordHash) return { error: "Session user not found." };
    const valid = await verifyPassword(sessionUser.passwordHash, parsed.data.currentPassword);
    if (!valid) {
      return { error: "Current password is incorrect." };
    }
  }

  const target = await db.user.findUnique({ where: { id: userId } });
  if (!belongsToHousehold(target, session.user.householdId)) {
    return { error: "Not found." };
  }

  const { role, dashboardScope } = ACCESS_LEVELS[parsed.data.accessLevel];

  if (target.role === "OWNER" && role !== "OWNER") {
    const otherOwners = await db.user.count({
      where: { householdId: session.user.householdId, role: "OWNER", id: { not: userId } },
    });
    if (otherOwners === 0) {
      return { error: "Every household needs at least one owner — promote someone else first." };
    }
  }

  if (parsed.data.email !== target.email) {
    const existing = await db.user.findUnique({ where: { email: parsed.data.email } });
    if (existing && existing.id !== userId) {
      return { error: "An account with that email already exists." };
    }
  }

  await db.user.update({
    where: { id: userId },
    data: {
      name: parsed.data.name,
      email: parsed.data.email,
      role,
      dashboardScope,
      ...(parsed.data.password ? { passwordHash: await hashPassword(parsed.data.password) } : {}),
    },
  });

  // Promoting a Basic member (CHILD, no TOTP) to a role that requires it
  // used to lock them out: authorize() rejects every password login for a
  // non-CHILD without totpEnabled, and their invite code was already spent
  // (2026-10-08 review). Hand back a fresh link straight to /setup-totp's
  // enrollment step. A still-pending invitee keeps their existing link.
  const setupUrl =
    role !== "CHILD" && !target.totpEnabled && target.passwordHash
      ? await issueTwoFactorSetupLink(userId)
      : undefined;

  await db.auditLog.create({
    data: {
      userId: session.user.id,
      action: "HOUSEHOLD_MEMBER_UPDATED",
      // Never the password itself, just whether it changed.
      detail: {
        targetUserId: userId,
        role,
        dashboardScope,
        nameChanged: parsed.data.name !== target.name,
        emailChanged: parsed.data.email !== target.email,
        passwordChanged: Boolean(parsed.data.password),
      },
    },
  });

  revalidatePath("/settings/members");
  return { setupUrl };
}

async function issueTwoFactorSetupLink(userId: string): Promise<string> {
  const inviteCode = generateInviteCode();
  await db.user.update({
    where: { id: userId },
    data: { inviteCode, inviteCodeExpiresAt: new Date(Date.now() + INVITE_CODE_TTL_MS) },
  });
  return `${await resolveAppOrigin()}/invite/${inviteCode}`;
}

// A fresh 2FA setup link for a member showing "2FA Pending" — password set,
// role requires TOTP, never enrolled. Owner-only, like every member edit.
export async function createTwoFactorSetupLink(userId: string): Promise<UpdateMemberResult> {
  const session = await auth();
  if (!session?.user) redirect("/login");
  if (session.user.role !== "OWNER") return { error: "Not authorized." };

  const target = await db.user.findUnique({ where: { id: userId } });
  if (!belongsToHousehold(target, session.user.householdId)) return { error: "Not found." };
  if (target.role === "CHILD" || target.totpEnabled || !target.passwordHash) {
    return { error: "This member doesn't need two-factor setup." };
  }
  return { setupUrl: await issueTwoFactorSetupLink(userId) };
}

export type DeleteMemberResult = { error?: string };

// Removes a member outright — including one that never finished setup
// (passwordHash still null, never logged in). Transaction.createdByUserId/
// Account.ownerId/SavingsContribution.createdByUserId all SetNull on
// delete (see their own schema comments) so a household's real financial
// data survives the person who happened to add it; AuditLog/Bucket.ownerId/
// PushSubscription/NotificationPreference/EmailConnection/
// WebAuthnCredential/BucketAlertOverride cascade — all per-user session/
// preference state with nothing left to mean anything once the account's
// gone.
export async function deleteMember(userId: string): Promise<DeleteMemberResult> {
  const session = await auth();
  if (!session?.user || session.user.role !== "OWNER") {
    return { error: "Not authorized." };
  }
  if (userId === session.user.id) {
    return { error: "You can't remove your own account this way." };
  }

  const target = await db.user.findUnique({ where: { id: userId } });
  if (!belongsToHousehold(target, session.user.householdId)) {
    return { error: "Not found." };
  }

  if (target.role === "OWNER") {
    const otherOwners = await db.user.count({
      where: { householdId: session.user.householdId, role: "OWNER", id: { not: userId } },
    });
    if (otherOwners === 0) {
      return { error: "Every household needs at least one owner — promote someone else first." };
    }
  }

  await db.user.delete({ where: { id: userId } });

  await db.auditLog.create({
    data: {
      userId: session.user.id,
      action: "HOUSEHOLD_MEMBER_REMOVED",
      detail: { removedUserId: userId, removedEmail: target.email, role: target.role },
    },
  });

  revalidatePath("/settings/members");
  return {};
}

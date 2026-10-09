"use server";

import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { verifySetupToken } from "@/lib/setup-token";
import { decrypt } from "@/lib/crypto";
import { hashPassword } from "@/lib/password";
import { claimTotpCode } from "@/lib/totp";
import { totpVerifySchema, accountDetailsSchema } from "@/lib/validation";

export type AccountDetailsState = { error?: string };

// First step of the setup-link flow for an invited member — collects the
// name/email/password the invite deliberately left unset (see
// inviteHouseholdMember, src/app/settings/members/actions.ts, which now
// only asks the owner for an access level) rather than the owner filling
// in someone else's identity and inventing a password for them. Redirects
// back to the same setup-totp URL rather than rendering the next step
// inline: the page component itself decides what's left to do purely from
// the user's current DB state (see its own comment), so re-entering
// through the normal page load keeps that single source of truth instead
// of duplicating the "what's next" logic here.
export async function setAccountDetails(
  _prev: AccountDetailsState,
  formData: FormData,
): Promise<AccountDetailsState> {
  const token = formData.get("token");
  if (typeof token !== "string") {
    return { error: "Missing setup link. Please use the link you were given." };
  }

  const verified = verifySetupToken(token);
  if (!verified) {
    return { error: "This setup link has expired. Ask for a new one." };
  }

  const parsed = accountDetailsSchema.safeParse({
    name: formData.get("name"),
    email: formData.get("email"),
    password: formData.get("password"),
    confirmPassword: formData.get("confirmPassword"),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  const user = await db.user.findUnique({ where: { id: verified.userId } });
  if (!user) {
    return { error: "Setup session not found. Please restart enrollment." };
  }
  // Already set (a resubmit, or the link reused after finishing) — nothing
  // left for this step to do; let the page's own state check route them.
  if (user.passwordHash) {
    redirect(`/setup-totp?token=${encodeURIComponent(token)}`);
  }

  const existing = await db.user.findUnique({ where: { email: parsed.data.email } });
  if (existing) {
    return { error: "An account with that email already exists." };
  }

  // CHILD never enrolls TOTP (see the authorize()/page's own role checks) —
  // this step IS the whole flow for them, so the short /invite/[code] link
  // (see its own comment) is fully spent right here; Owner/Partner still
  // need it for the QR step next, so it stays live until
  // verifyTotpEnrollment finishes below.
  await db.user.update({
    where: { id: user.id },
    data: {
      name: parsed.data.name,
      email: parsed.data.email,
      passwordHash: await hashPassword(parsed.data.password),
      ...(user.role === "CHILD" ? { inviteCode: null, inviteCodeExpiresAt: null } : {}),
    },
  });
  await db.auditLog.create({
    data: { userId: user.id, action: "ACCOUNT_DETAILS_SET" },
  });

  if (user.role === "CHILD") {
    redirect("/login?enrolled=1");
  }

  redirect(`/setup-totp?token=${encodeURIComponent(token)}`);
}

export type TotpVerifyState = { error?: string };

export async function verifyTotpEnrollment(
  _prev: TotpVerifyState,
  formData: FormData,
): Promise<TotpVerifyState> {
  const token = formData.get("token");
  if (typeof token !== "string") {
    return { error: "Missing setup link. Please use the link you were given." };
  }

  const verified = verifySetupToken(token);
  if (!verified) {
    return { error: "This setup link has expired. Ask for a new one." };
  }

  const parsed = totpVerifySchema.safeParse({ code: formData.get("code") });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid code" };
  }

  const user = await db.user.findUnique({ where: { id: verified.userId } });
  if (!user || !user.totpSecretEncrypted) {
    return { error: "Setup session not found. Please restart enrollment." };
  }

  if (!user.totpEnabled) {
    const secret = decrypt(user.totpSecretEncrypted);
    // Claimed, not just checked — the enrollment code can't then be
    // replayed as a login code within its own window.
    if (!(await claimTotpCode(user, secret, parsed.data.code))) {
      return {
        error:
          "That code didn't match. Check the time on your authenticator app and try again.",
      };
    }

    await db.user.update({
      where: { id: user.id },
      // Setup is fully done now — the short /invite/[code] link (see its
      // own comment) has nothing left to resolve to.
      data: { totpEnabled: true, totpVerifiedAt: new Date(), inviteCode: null, inviteCodeExpiresAt: null },
    });
    await db.auditLog.create({
      data: { userId: user.id, action: "TOTP_ENROLLED" },
    });
  }

  redirect("/login?enrolled=1");
}

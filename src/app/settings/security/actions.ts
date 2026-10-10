"use server";

import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { revalidateHousehold } from "@/lib/revalidate";

async function requireSession() {
  const session = await auth();
  if (!session?.user) return null;
  return session.user;
}

export type PasskeyActionResult = { ok: true } | { ok: false; error: string };

// A personal login-security setting, not a financial-access one — any
// signed-in user manages their own passkeys here regardless of role or
// dashboardScope (unlike most of /settings, which gates on hasFullAccess).
export async function removePasskey(id: string): Promise<PasskeyActionResult> {
  const user = await requireSession();
  if (!user) return { ok: false, error: "Not signed in." };

  const credential = await db.webAuthnCredential.findUnique({ where: { id } });
  if (!credential || credential.userId !== user.id) {
    return { ok: false, error: "That passkey wasn't found." };
  }

  await db.webAuthnCredential.delete({ where: { id } });
  await db.auditLog.create({
    data: { userId: user.id, action: "PASSKEY_REMOVED", detail: { nickname: credential.nickname } },
  });

  revalidateHousehold();
  return { ok: true };
}

export async function renamePasskey(id: string, nickname: string): Promise<PasskeyActionResult> {
  const user = await requireSession();
  if (!user) return { ok: false, error: "Not signed in." };

  const trimmed = nickname.trim();
  if (!trimmed) return { ok: false, error: "Give it a name." };

  const credential = await db.webAuthnCredential.findUnique({ where: { id } });
  if (!credential || credential.userId !== user.id) {
    return { ok: false, error: "That passkey wasn't found." };
  }

  await db.webAuthnCredential.update({
    where: { id },
    data: { nickname: trimmed.slice(0, 60) },
  });

  revalidateHousehold();
  return { ok: true };
}

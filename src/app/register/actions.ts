"use server";

import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { hashPassword } from "@/lib/password";
import { registerSchema } from "@/lib/validation";
import { createSetupToken } from "@/lib/setup-token";
import { DEFAULT_BILL_CATEGORY_NAMES } from "@/lib/bill-category";

export type RegisterState = { error?: string };

export async function registerHousehold(
  _prev: RegisterState,
  formData: FormData,
): Promise<RegisterState> {
  // Bootstrap-only: this is a closed household app, not a public sign-up
  // service. Once the first household exists, further members are added by
  // an existing OWNER/PARENT via an invite link (see settings/members).
  // The read-only example household (Household.isDemo) doesn't count — it's
  // not a real signup and must never be what closes registration.
  const householdCount = await db.household.count({ where: { isDemo: false } });
  if (householdCount > 0) {
    return {
      error:
        "Registration is closed. Ask an existing household member for an invite link.",
    };
  }

  const parsed = registerSchema.safeParse({
    householdName: formData.get("householdName"),
    name: formData.get("name"),
    email: formData.get("email"),
    password: formData.get("password"),
  });

  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  const { householdName, name, email, password } = parsed.data;

  const existing = await db.user.findUnique({ where: { email } });
  if (existing) {
    return { error: "An account with that email already exists." };
  }

  const passwordHash = await hashPassword(password);

  const user = await db.$transaction(async (tx) => {
    const household = await tx.household.create({
      data: { name: householdName },
    });
    await tx.billCategory.createMany({
      data: DEFAULT_BILL_CATEGORY_NAMES.map((name) => ({ householdId: household.id, name })),
    });
    return tx.user.create({
      data: {
        householdId: household.id,
        name,
        email,
        passwordHash,
        role: "OWNER",
      },
    });
  });

  await db.auditLog.create({
    data: { userId: user.id, action: "HOUSEHOLD_REGISTERED" },
  });

  const token = createSetupToken(user.id);
  redirect(`/setup-totp?token=${encodeURIComponent(token)}`);
}

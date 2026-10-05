"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { encrypt, decrypt } from "@/lib/crypto";
import { verifyAiConfig } from "@/lib/ai-provider";

async function requireOwner() {
  const session = await auth();
  if (!session?.user) redirect("/login");
  if (session.user.role !== "OWNER") redirect("/");
  return session;
}

export type AiSettingsState = { error?: string };

const saveSchema = z.object({
  provider: z.enum(["GEMINI", "OPENAI", "ANTHROPIC", "GROK"]),
  apiKey: z.string().trim().min(1),
});

export async function saveAiSettings(
  _prev: AiSettingsState,
  formData: FormData,
): Promise<AiSettingsState> {
  const session = await requireOwner();

  const parsed = saveSchema.safeParse({
    provider: formData.get("provider"),
    apiKey: formData.get("apiKey"),
  });
  if (!parsed.success) return { error: "Pick a provider and paste your API key." };

  // Verify with a real test call before persisting anything — a typo'd or
  // revoked key should never be reported as "saved."
  const verifyError = await verifyAiConfig({ provider: parsed.data.provider, apiKey: parsed.data.apiKey });
  if (verifyError) return { error: `Couldn't verify this key: ${verifyError}` };

  await db.householdAiSettings.upsert({
    where: { householdId: session.user.householdId },
    create: {
      householdId: session.user.householdId,
      provider: parsed.data.provider,
      apiKeyEncrypted: encrypt(parsed.data.apiKey),
      status: "ACTIVE",
      lastError: null,
    },
    update: {
      provider: parsed.data.provider,
      apiKeyEncrypted: encrypt(parsed.data.apiKey),
      status: "ACTIVE",
      lastError: null,
    },
  });

  revalidatePath("/settings/ai");
  revalidatePath("/settings");
  return {};
}

export async function disconnectAiSettings() {
  const session = await requireOwner();
  await db.householdAiSettings.deleteMany({ where: { householdId: session.user.householdId } });
  revalidatePath("/settings/ai");
  revalidatePath("/settings");
}

// A household's manual "try again now" for a connection sitting in ERROR —
// re-runs the exact same real test call saveAiSettings does at save time,
// against the already-stored key, and writes the result back onto
// status/lastError the same way every live AI call already does via
// recordAiHealth (src/lib/ai-provider.ts). Useful for a transient failure
// (provider outage, a since-lifted rate limit) that would otherwise just
// sit red until the next real feature call happens to retry it — lets a
// household clear it on demand instead of waiting.
export async function retestAiConnection() {
  const session = await requireOwner();

  const existing = await db.householdAiSettings.findUnique({ where: { householdId: session.user.householdId } });
  if (!existing) return;

  let apiKey: string;
  try {
    apiKey = decrypt(existing.apiKeyEncrypted);
  } catch (err) {
    await db.householdAiSettings.update({
      where: { householdId: session.user.householdId },
      data: { status: "ERROR", lastError: err instanceof Error ? err.message : "Stored key could not be decrypted." },
    });
    revalidatePath("/settings/ai");
    revalidatePath("/settings");
    return;
  }

  const verifyError = await verifyAiConfig({ provider: existing.provider, apiKey });
  await db.householdAiSettings.update({
    where: { householdId: session.user.householdId },
    data: { status: verifyError ? "ERROR" : "ACTIVE", lastError: verifyError },
  });

  revalidatePath("/settings/ai");
  revalidatePath("/settings");
}

import { cache } from "react";
import { db } from "@/lib/db";
import { isDemoHousehold } from "@/lib/demo";

// "Needs attention" for the Settings page badge — no connection at all
// counts too, not just a connected-but-erroring one, matching the same
// treatment as needsAiAttention (src/lib/ai-provider.ts).
// cache(): the app shell and the dashboard both ask on the same request.
export const needsBankConnectionAttention = cache(async function needsBankConnectionAttention(householdId: string): Promise<boolean> {
  // The demo's SimpleFIN demo-server connection is left ACTIVE/error-free by
  // the seed and never synced again (excluded from syncAllHouseholds), so it
  // shouldn't nag — and if it ever did error, its OWNER can't fix it anyway.
  if (await isDemoHousehold(householdId)) return false;
  const connection = await db.bankConnection.findUnique({ where: { householdId }, select: { lastError: true } });
  return !connection || Boolean(connection.lastError);
});

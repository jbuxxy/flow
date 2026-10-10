import { revalidatePath } from "next/cache";

// Refreshes every page after a mutation. Every page here is dynamic (it reads
// the signed-in session) and next.config sets staleTimes.dynamic: 0, so a
// per-path list bought nothing but upkeep: 387 hand-maintained
// revalidatePath calls, which had already drifted (/debts' actions refreshed
// /debts 59 times but /bills — which shows the same debt cards — twice).
// Call from a server action only; Next rejects revalidation during render.
export function revalidateHousehold(): void {
  revalidatePath("/", "layout");
}

"use server";

import { auth } from "@/lib/auth";
import { fetchTopCoins } from "@/lib/crypto-lookup";

// Called directly from client components (CryptoEstimateFields), not bound
// to a form — same pattern as getVehicleMakes/getVehicleModels.
export async function getTopCoins(): Promise<{ id: string; symbol: string; name: string }[]> {
  const session = await auth();
  if (!session?.user) return [];
  return fetchTopCoins();
}

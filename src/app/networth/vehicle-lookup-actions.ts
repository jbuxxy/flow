"use server";

import { auth } from "@/lib/auth";
import { fetchVehicleMakes, fetchVehicleModels } from "@/lib/vehicle-lookup";

// Called directly from client components (VehicleEstimateFields), not bound
// to a form — same pattern as linkAssetAccount's onChange call.
export async function getVehicleMakes(): Promise<string[]> {
  const session = await auth();
  if (!session?.user) return [];
  return fetchVehicleMakes();
}

export async function getVehicleModels(make: string): Promise<string[]> {
  const session = await auth();
  if (!session?.user) return [];
  return fetchVehicleModels(make);
}

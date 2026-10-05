import { fetchJsonWithRetry } from "@/lib/fetch-json";

const VPIC_BASE = "https://vpic.nhtsa.dot.gov/api/vehicles";

// NHTSA's free, public vehicle registry API (no key, no auth) — the only
// legitimate source for "what makes/models exist" without hand-maintaining
// a list that goes stale. GetMakesForVehicleType scopes to passenger-
// relevant categories; GetAllMakes alone returns ~10k entries including
// buses, trailers, and motorcycles that would just be noise here. There is
// no equivalent free endpoint for trim (vPIC's trim data isn't organized
// per make/model/year) — trim stays a plain text field.
const PASSENGER_VEHICLE_TYPES = ["car", "truck", "multipurpose passenger vehicle (mpv)"];

let makesCache: { at: number; makes: string[] } | null = null;
const MAKES_CACHE_MS = 24 * 60 * 60 * 1000;

export async function fetchVehicleMakes(): Promise<string[]> {
  if (makesCache && Date.now() - makesCache.at < MAKES_CACHE_MS) return makesCache.makes;

  try {
    const results = await Promise.all(
      PASSENGER_VEHICLE_TYPES.map(async (type) => {
        const data = (await fetchJsonWithRetry(
          `${VPIC_BASE}/GetMakesForVehicleType/${encodeURIComponent(type)}?format=json`,
        )) as { Results?: { MakeName: string }[] };
        return (data.Results ?? []).map((r) => r.MakeName.trim());
      }),
    );
    const makes = Array.from(new Set(results.flat())).sort((a, b) => a.localeCompare(b));
    if (makes.length > 0) makesCache = { at: Date.now(), makes };
    return makes;
  } catch (err) {
    console.error("[vehicle-lookup] fetching makes failed:", err instanceof Error ? err.message : err);
    return makesCache?.makes ?? [];
  }
}

export async function fetchVehicleModels(make: string): Promise<string[]> {
  if (!make.trim()) return [];

  try {
    const data = (await fetchJsonWithRetry(
      `${VPIC_BASE}/GetModelsForMake/${encodeURIComponent(make.trim())}?format=json`,
    )) as { Results?: { Model_Name: string }[] };
    const models = (data.Results ?? []).map((r) => r.Model_Name.trim());
    return Array.from(new Set(models)).sort((a, b) => a.localeCompare(b));
  } catch (err) {
    console.error("[vehicle-lookup] fetching models failed:", err instanceof Error ? err.message : err);
    return [];
  }
}

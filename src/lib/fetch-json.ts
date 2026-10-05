// Shared by vehicle-lookup.ts (NHTSA) and crypto-lookup.ts (CoinGecko) — both
// free, public, no-auth APIs with no SLA that occasionally have a slow/failed
// individual request with no indication why. One retry is enough to ride out
// a transient hiccup (see WORKING_ON.md for how this was diagnosed on the
// NHTSA side: a live repro succeeded seconds after a user hit an empty
// result, with nothing in the app or the API's data actually wrong).
export async function fetchJsonWithRetry(url: string, attempts = 2): Promise<unknown> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url);
      if (!res.ok) {
        lastErr = new Error(`HTTP ${res.status}`);
        continue;
      }
      return await res.json();
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

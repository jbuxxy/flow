import { fetchJsonWithRetry } from "@/lib/fetch-json";

const COINGECKO_BASE = "https://api.coingecko.com/api/v3";

export type CryptoEstimateDetails = { coinId: string; symbol: string; quantity: number };

let coinsCache: { at: number; coins: { id: string; symbol: string; name: string }[] } | null = null;
const COINS_CACHE_MS = 24 * 60 * 60 * 1000;

// CoinGecko's free public API (no key). /coins/markets sorted by market cap
// covers every coin a household is realistically holding (BTC, ETH, SOL,
// USDC, Coinbase's own listings, etc. all sit in the top couple hundred)
// while staying small enough for a type-to-filter dropdown — unlike
// /coins/list's ~17k-entry full registry, most of which is dead/scam tokens.
export async function fetchTopCoins(): Promise<{ id: string; symbol: string; name: string }[]> {
  if (coinsCache && Date.now() - coinsCache.at < COINS_CACHE_MS) return coinsCache.coins;

  try {
    const data = (await fetchJsonWithRetry(
      `${COINGECKO_BASE}/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=250&page=1`,
    )) as { id: string; symbol: string; name: string }[];
    const coins = data.map((c) => ({ id: c.id, symbol: c.symbol.toUpperCase(), name: c.name }));
    if (coins.length > 0) coinsCache = { at: Date.now(), coins };
    return coins;
  } catch (err) {
    console.error("[crypto-lookup] fetching coin list failed:", err instanceof Error ? err.message : err);
    return coinsCache?.coins ?? [];
  }
}

// Unlike vehicle/home value (a general-knowledge AI ballpark, re-checked
// monthly), a crypto holding's worth is a real, continuously-moving market
// price — so this is a live lookup, called on every net worth page load
// rather than gated behind refreshStaleAssetEstimates's monthly cache.
//
// Returns the raw (unrounded) per-unit USD price, not cents — a meme coin
// like SHIB or BONK trades at a small fraction of a cent per token, and
// rounding *that* to the nearest cent before multiplying by quantity
// collapses the per-unit price to 0, zeroing out an otherwise real holding
// (a household really did see two of their crypto assets show $0 this way).
// Callers multiply by quantity first and round the *total* to cents once.
export async function fetchCryptoPriceUsd(coinId: string): Promise<number | null> {
  try {
    const data = (await fetchJsonWithRetry(
      `${COINGECKO_BASE}/simple/price?ids=${encodeURIComponent(coinId)}&vs_currencies=usd`,
    )) as Record<string, { usd?: number }>;
    const usd = data[coinId]?.usd;
    if (typeof usd !== "number") return null;
    return usd;
  } catch (err) {
    console.error("[crypto-lookup] fetching price failed:", err instanceof Error ? err.message : err);
    return null;
  }
}

// Same {valueCents, reasoning} shape as estimateVehicleValue/estimateHomeValue
// in src/lib/ai.ts so networth/actions.ts's estimateFor can treat all three
// uniformly, even though this path never touches Gemini.
export async function estimateCryptoValue(
  details: CryptoEstimateDetails,
): Promise<{ valueCents: number; reasoning: string } | null> {
  const priceUsd = await fetchCryptoPriceUsd(details.coinId);
  if (priceUsd === null) return null;
  return {
    valueCents: Math.round(priceUsd * details.quantity * 100),
    reasoning: `Live price for ${details.symbol} via CoinGecko`,
  };
}

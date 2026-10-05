"use client";

import { useEffect, useState, useTransition } from "react";
import { getTopCoins } from "./crypto-lookup-actions";
import { SelectField } from "@/components/select-field";

const inputClass =
  "rounded-lg border border-neutral-300 dark:border-neutral-700 px-2 py-2 text-sm focus:border-blue-900 focus:outline-none disabled:opacity-50 disabled:cursor-not-allowed";

// Coin list comes from CoinGecko's top-250-by-market-cap (see
// fetchTopCoins) — plenty to cover a household's actual holdings (BTC, ETH,
// SOL, USDC, and anything else Coinbase would list) without a 17k-entry
// dropdown. Symbol is carried alongside the id (CoinGecko's price lookup
// needs the id; the label the household actually recognizes is the symbol)
// via a plain hidden input since SelectField only tracks one value/name pair.
export function CryptoEstimateFields({
  defaultCoinId,
  defaultSymbol,
  defaultQuantity,
}: {
  defaultCoinId?: string;
  defaultSymbol?: string;
  defaultQuantity?: number;
}) {
  const [coinId, setCoinId] = useState(defaultCoinId ?? "");
  const [coins, setCoins] = useState<{ id: string; symbol: string; name: string }[]>(
    defaultCoinId && defaultSymbol ? [{ id: defaultCoinId, symbol: defaultSymbol, name: defaultSymbol }] : [],
  );
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    startTransition(() => {
      getTopCoins().then((fetched) => {
        setCoins((prev) => {
          const merged = new Map(prev.map((c) => [c.id, c]));
          for (const c of fetched) merged.set(c.id, c);
          return Array.from(merged.values());
        });
      });
    });
  }, []);

  const symbol = coins.find((c) => c.id === coinId)?.symbol ?? defaultSymbol ?? "";

  return (
    <>
      <SelectField
        name="coinId"
        value={coinId}
        onChange={setCoinId}
        placeholder={pending && coins.length === 0 ? "Loading Coins…" : "Coin"}
        options={coins.map((c) => ({ value: c.id, label: `${c.name} (${c.symbol})` }))}
      />
      <input type="hidden" name="symbol" value={symbol} />
      <input
        name="quantity"
        placeholder="Quantity (e.g. 0.5)"
        defaultValue={defaultQuantity ?? ""}
        inputMode="decimal"
        className={inputClass}
      />
    </>
  );
}

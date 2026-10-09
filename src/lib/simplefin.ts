// Minimal SimpleFIN Bridge client. Protocol (https://www.simplefin.org/protocol.html):
//   1. User pastes a one-time "setup token" — base64 of a claim URL.
//   2. We POST to the claim URL (empty body) and get back the permanent
//      access URL in the response body. The access URL has HTTP Basic Auth
//      credentials embedded (scheme://user:pass@host/path) and never expires
//      until the user revokes it on SimpleFIN's side.
//   3. GET `${accessUrl}/accounts` (with the same Basic Auth) returns JSON of
//      every linked account plus its transactions since `start-date`.
// No OAuth dance, no per-bank SDK — this whole file is the integration.

import { fetchPublic } from "@/lib/ssrf-guard";

export async function claimSetupToken(setupToken: string): Promise<string> {
  let claimUrl: string;
  try {
    claimUrl = Buffer.from(setupToken.trim(), "base64").toString("utf-8");
  } catch {
    throw new Error("That doesn't look like a valid SimpleFIN setup token.");
  }
  if (!claimUrl.startsWith("http")) {
    throw new Error("That doesn't look like a valid SimpleFIN setup token.");
  }
  // The claim URL is whatever a pasted-in "setup token" decodes to — never
  // trust it's really simplefin.org without checking (see ssrf-guard.ts).
  const res = await fetchPublic(claimUrl, { method: "POST" });
  if (!res.ok) {
    throw new Error(`SimpleFIN rejected the setup token (${res.status}). It may already be claimed.`);
  }
  const accessUrl = (await res.text()).trim();
  if (!accessUrl.startsWith("http")) {
    throw new Error("SimpleFIN returned an unexpected response while claiming the token.");
  }
  return accessUrl;
}

function withBasicAuth(accessUrl: string): { baseUrl: string; headers: Record<string, string> } {
  const u = new URL(accessUrl);
  const username = decodeURIComponent(u.username);
  const password = decodeURIComponent(u.password);
  u.username = "";
  u.password = "";
  const headers: Record<string, string> = {};
  if (username || password) {
    headers.Authorization = "Basic " + Buffer.from(`${username}:${password}`).toString("base64");
  }
  return { baseUrl: u.toString().replace(/\/$/, ""), headers };
}

export type SimpleFinTransaction = {
  id: string;
  posted: number; // unix seconds
  amount: string; // decimal string; negative = money out
  description: string;
  payee?: string;
  memo?: string;
  pending?: boolean;
};

export type SimpleFinAccount = {
  id: string;
  name: string;
  currency: string;
  balance: string; // decimal string
  "balance-date"?: number;
  org?: { name?: string; domain?: string };
  transactions?: SimpleFinTransaction[];
};

export async function fetchSimpleFinData(
  accessUrl: string,
  opts: { startDate?: Date; includePending?: boolean; accountIds?: string[] } = {},
): Promise<{ accounts: SimpleFinAccount[]; errors: string[] }> {
  const { baseUrl, headers } = withBasicAuth(accessUrl);
  const endpoint = new URL(`${baseUrl}/accounts`);
  if (opts.startDate) {
    endpoint.searchParams.set("start-date", String(Math.floor(opts.startDate.getTime() / 1000)));
  }
  if (opts.includePending) {
    endpoint.searchParams.set("pending", "1");
  }
  // Scopes the request to specific accounts (repeated `account` params, per
  // the SimpleFIN protocol) — used for a one-off deeper backfill on an
  // account that just appeared under an already-syncing connection, without
  // re-fetching every other account's history too.
  for (const id of opts.accountIds ?? []) {
    endpoint.searchParams.append("account", id);
  }
  // Re-checked on every sync (and every redirect hop), not just at connect time — accessUrl was
  // itself the response body of a request we didn't fully control (see
  // claimSetupToken), and DNS can change between syncs.
  const res = await fetchPublic(endpoint.toString(), { headers });
  if (!res.ok) {
    throw new Error(`SimpleFIN request failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
  }
  const data = (await res.json()) as { accounts?: SimpleFinAccount[]; errors?: string[] };
  return { accounts: data.accounts ?? [], errors: data.errors ?? [] };
}

// SimpleFIN sends amounts/balances as decimal strings ("-42.17"). Parsing via
// parseFloat and multiplying by 100 risks float drift, so this parses the
// string directly into integer cents.
export function decimalStringToCents(value: string): number {
  const trimmed = value.trim();
  const negative = trimmed.startsWith("-");
  const unsigned = trimmed.replace(/^[-+]/, "");
  const [wholeRaw, fracRaw = ""] = unsigned.split(".");
  const whole = wholeRaw || "0";
  const frac = (fracRaw + "00").slice(0, 2);
  const cents = Number(whole) * 100 + Number(frac);
  return negative ? -cents : cents;
}

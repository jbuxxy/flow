"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { canViewNetWorth, belongsToHousehold } from "@/lib/access";
import { parseDollarsToCents } from "@/lib/money";
import { todayAsUTCDate } from "@/lib/date";
import {
  estimateVehicleValue,
  estimateHomeValue,
  type VehicleEstimateDetails,
  type HomeEstimateDetails,
} from "@/lib/ai";
import { estimateCryptoValue, type CryptoEstimateDetails } from "@/lib/crypto-lookup";

const ASSET_TYPES = [
  "RETIREMENT_401K",
  "RETIREMENT_IRA",
  "RETIREMENT_PENSION",
  "HOME_EQUITY",
  "VEHICLE_EQUITY",
  "INVESTMENT",
  "CRYPTO",
  "OTHER",
] as const;


const CONDITIONS = ["EXCELLENT", "GOOD", "FAIR", "POOR"] as const;

const vehicleDetailsSchema = z.object({
  year: z.coerce.number().int().min(1900).max(2100),
  make: z.string().trim().min(1).max(40),
  model: z.string().trim().min(1).max(40),
  trim: z.string().trim().max(40).optional(),
  mileage: z.coerce.number().int().min(0).max(1_000_000).optional(),
  condition: z.enum(CONDITIONS).optional(),
});

// Trailers and anything else that doesn't fit the NHTSA year/make/model
// lookup (see vehicle-lookup.ts's comment on why trailers were excluded
// from that list) — a plain description instead, same condition field.
const vehicleFreeformSchema = z.object({
  description: z.string().trim().min(1).max(300),
  condition: z.enum(CONDITIONS).optional(),
});

const homeDetailsSchema = z.object({
  address: z.string().trim().min(1).max(200),
  bedrooms: z.coerce.number().min(0).max(50).optional(),
  bathrooms: z.coerce.number().min(0).max(50).optional(),
  sqft: z.coerce.number().int().min(0).max(1_000_000).optional(),
});

const cryptoDetailsSchema = z.object({
  coinId: z.string().trim().min(1).max(60),
  symbol: z.string().trim().min(1).max(10),
  quantity: z.coerce.number().positive(),
});

// Shared by createAsset (new VEHICLE_EQUITY/HOME_EQUITY/CRYPTO asset) and
// updateAssetEstimateDetails (existing one) — reads whichever of the
// vehicle/home/crypto fields are present on the form and validates against
// the asset type actually selected, dropping the other types' fields
// entirely rather than trying to guess.
function parseEstimateDetails(
  assetType: (typeof ASSET_TYPES)[number],
  formData: FormData,
): { details: VehicleEstimateDetails | HomeEstimateDetails | CryptoEstimateDetails | null; error?: string } {
  if (assetType === "VEHICLE_EQUITY") {
    const description = formData.get("description");
    if (description) {
      const parsed = vehicleFreeformSchema.safeParse({
        description,
        condition: formData.get("condition") || undefined,
      });
      if (!parsed.success) return { details: null, error: "Enter a description." };
      return { details: parsed.data };
    }
    const year = formData.get("year");
    const make = formData.get("make");
    const model = formData.get("model");
    if (!year && !make && !model) return { details: null };
    const parsed = vehicleDetailsSchema.safeParse({
      year,
      make,
      model,
      trim: formData.get("trim") || undefined,
      mileage: formData.get("mileage") || undefined,
      condition: formData.get("condition") || undefined,
    });
    if (!parsed.success) return { details: null, error: "Enter a valid year/make/model." };
    return { details: parsed.data };
  }
  if (assetType === "HOME_EQUITY") {
    const address = formData.get("address");
    if (!address) return { details: null };
    const parsed = homeDetailsSchema.safeParse({
      address,
      bedrooms: formData.get("bedrooms") || undefined,
      bathrooms: formData.get("bathrooms") || undefined,
      sqft: formData.get("sqft") || undefined,
    });
    if (!parsed.success) return { details: null, error: "Enter a valid address." };
    return { details: parsed.data };
  }
  if (assetType === "CRYPTO") {
    const coinId = formData.get("coinId");
    const quantity = formData.get("quantity");
    if (!coinId && !quantity) return { details: null };
    const parsed = cryptoDetailsSchema.safeParse({
      coinId,
      symbol: formData.get("symbol"),
      quantity,
    });
    if (!parsed.success) return { details: null, error: "Pick a coin and enter a quantity." };
    return { details: parsed.data };
  }
  return { details: null };
}

function estimateFor(
  householdId: string,
  assetType: (typeof ASSET_TYPES)[number],
  details: VehicleEstimateDetails | HomeEstimateDetails | CryptoEstimateDetails,
) {
  if (assetType === "VEHICLE_EQUITY") return estimateVehicleValue(householdId, details as VehicleEstimateDetails);
  if (assetType === "HOME_EQUITY") return estimateHomeValue(householdId, details as HomeEstimateDetails);
  if (assetType === "CRYPTO") return estimateCryptoValue(details as CryptoEstimateDetails);
  return Promise.resolve(null);
}

const createAssetSchema = z.object({
  name: z.string().trim().min(1).max(80),
  assetType: z.enum(ASSET_TYPES),
  value: z.string().optional(),
  asOfDate: z.string(),
});

export type AssetFormState = { error?: string };

export async function createAsset(
  _prev: AssetFormState,
  formData: FormData,
): Promise<AssetFormState> {
  const session = await auth();
  if (!session?.user) redirect("/login");
  if (!canViewNetWorth(session.user)) return { error: "Not authorized." };

  const parsed = createAssetSchema.safeParse({
    name: formData.get("name"),
    assetType: formData.get("assetType"),
    value: formData.get("value") || undefined,
    asOfDate: formData.get("asOfDate"),
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input" };

  const asOfDate = new Date(parsed.data.asOfDate);
  if (Number.isNaN(asOfDate.getTime())) return { error: "Enter a valid date." };

  const { details, error: detailsError } = parseEstimateDetails(parsed.data.assetType, formData);
  if (detailsError) return { error: detailsError };

  let valueCents: number | null = parsed.data.value ? parseDollarsToCents(parsed.data.value) : null;
  let estimateUpdatedAt: Date | null = null;
  let source: "MANUAL" | "AI_ESTIMATE" | "LIVE_PRICE" = "MANUAL";

  if (valueCents === null && details) {
    // No manual value given, but vehicle/home/crypto details were — get an
    // opening estimate right away instead of leaving this at $0 for up to
    // a month waiting on the next lazy refresh (or, for crypto, until the
    // next page load).
    const estimate = await estimateFor(session.user.householdId, parsed.data.assetType, details);
    if (!estimate) {
      return {
        error:
          parsed.data.assetType === "CRYPTO"
            ? "Couldn't get a live price right now — enter a value manually."
            : "Couldn't get an AI estimate right now — enter a value manually.",
      };
    }
    valueCents = estimate.valueCents;
    estimateUpdatedAt = new Date();
    source = parsed.data.assetType === "CRYPTO" ? "LIVE_PRICE" : "AI_ESTIMATE";
  } else if (details) {
    // Manual value provided alongside details — that value is authoritative
    // for this month; stamp estimateUpdatedAt so the lazy monthly refresh
    // doesn't immediately overwrite it on the next page load.
    estimateUpdatedAt = new Date();
  }

  if (valueCents === null) return { error: "Enter a value." };

  await db.asset.create({
    data: {
      householdId: session.user.householdId,
      name: parsed.data.name,
      assetType: parsed.data.assetType,
      valueCents,
      asOfDate,
      source,
      estimateDetails: details ?? undefined,
      estimateUpdatedAt,
    },
  });

  revalidatePath("/networth");
  return {};
}

const estimateNameSchema = z.object({ name: z.string().trim().min(1).max(80) });

// Adds/updates the vehicle/home/crypto specifics on an existing asset and
// immediately re-estimates from them — the "look this up for me" action,
// distinct from updateAssetValue's plain manual override. Also carries the
// name field: once an asset is AI/live-price-managed, this is its only edit
// form (see asset-row.tsx), so it has to cover renaming too, not just the
// vehicle/home/crypto specifics.
export async function updateAssetEstimateDetails(
  assetId: string,
  _prev: AssetFormState,
  formData: FormData,
): Promise<AssetFormState> {
  const session = await auth();
  if (!session?.user) redirect("/login");
  if (!canViewNetWorth(session.user)) return { error: "Not authorized." };

  const asset = await db.asset.findUnique({ where: { id: assetId } });
  if (!belongsToHousehold(asset, session.user.householdId)) return { error: "Not found." };
  if (asset.assetType !== "VEHICLE_EQUITY" && asset.assetType !== "HOME_EQUITY" && asset.assetType !== "CRYPTO") {
    return { error: "Estimates are only available for vehicles, homes, and crypto." };
  }

  const nameParsed = estimateNameSchema.safeParse({ name: formData.get("name") });
  if (!nameParsed.success) return { error: "Enter a name." };

  const { details, error: detailsError } = parseEstimateDetails(asset.assetType, formData);
  if (detailsError) return { error: detailsError };
  if (!details) return { error: "Fill in the details to get an estimate." };

  const estimate = await estimateFor(session.user.householdId, asset.assetType, details);
  if (!estimate) {
    return {
      error:
        asset.assetType === "CRYPTO"
          ? "Couldn't get a live price right now — try again later."
          : "Couldn't get an AI estimate right now — try again later.",
    };
  }

  await db.asset.update({
    where: { id: assetId },
    data: {
      name: nameParsed.data.name,
      estimateDetails: details,
      valueCents: estimate.valueCents,
      asOfDate: todayAsUTCDate(), // @db.Date — the local calendar day, not a raw UTC instant
      estimateUpdatedAt: new Date(),
      source: asset.assetType === "CRYPTO" ? "LIVE_PRICE" : "AI_ESTIMATE",
    },
  });
  revalidatePath("/networth");
  return {};
}

// One-click re-run for an asset that's already AI/live-price-managed —
// reuses its already-saved estimateDetails as-is, no form needed. Used by
// the row's Sparkles button so a household can force a refresh ahead of
// refreshStaleAssetEstimates's monthly cadence without reopening the pencil
// edit form and resubmitting unchanged details.
export async function rerunAssetEstimate(assetId: string) {
  const session = await auth();
  if (!session?.user) redirect("/login");
  if (!canViewNetWorth(session.user)) return;

  const asset = await db.asset.findUnique({ where: { id: assetId } });
  if (!belongsToHousehold(asset, session.user.householdId)) return;
  if (asset.assetType !== "VEHICLE_EQUITY" && asset.assetType !== "HOME_EQUITY" && asset.assetType !== "CRYPTO") return;
  if (!asset.estimateDetails) return;

  const estimate = await estimateFor(
    session.user.householdId,
    asset.assetType,
    asset.estimateDetails as unknown as VehicleEstimateDetails | HomeEstimateDetails | CryptoEstimateDetails,
  );
  if (!estimate) return;

  await db.asset.update({
    where: { id: assetId },
    data: {
      valueCents: estimate.valueCents,
      asOfDate: todayAsUTCDate(), // @db.Date — the local calendar day, not a raw UTC instant
      estimateUpdatedAt: new Date(),
      source: asset.assetType === "CRYPTO" ? "LIVE_PRICE" : "AI_ESTIMATE",
    },
  });
  revalidatePath("/networth");
}

// One-click "start tracking this synced investment account" — unlike debts,
// nothing here needs the user's input: name, value, and a reasonable
// assetType guess (401k/IRA/brokerage, from the account name) all come from
// the sync already.
export async function trackAccountAsAsset(accountId: string) {
  const session = await auth();
  if (!session?.user) redirect("/login");
  if (!canViewNetWorth(session.user)) return;

  const account = await db.account.findUnique({ where: { id: accountId } });
  if (!belongsToHousehold(account, session.user.householdId)) return;

  const displayName = account.displayName ?? account.name;
  const lower = displayName.toLowerCase();
  const assetType = lower.includes("401k") || lower.includes("401(k)")
    ? "RETIREMENT_401K"
    : lower.includes(" ira") || lower.startsWith("ira")
      ? "RETIREMENT_IRA"
      : lower.includes("pension")
        ? "RETIREMENT_PENSION"
        : "INVESTMENT";

  await db.asset.create({
    data: {
      householdId: session.user.householdId,
      name: displayName,
      assetType,
      valueCents: Math.max(account.balanceCents, 0),
      asOfDate: todayAsUTCDate(), // @db.Date — the local calendar day, not a raw UTC instant
      accountId: account.id,
      source: "SIMPLEFIN",
    },
  });

  revalidatePath("/networth");
}

// A cash (CHECKING/SAVINGS) account has no Asset row to delete the way an
// INVESTMENT account's does (see deleteAsset) — this flag is the equivalent
// off-switch, with the same "still syncs, just not counted" semantics.
// getNetWorth's cashAccounts query filters it out; includeCashAccount below
// is the "Connected but not counted" re-add.
export async function excludeCashAccount(accountId: string) {
  const session = await auth();
  if (!session?.user) redirect("/login");
  if (!canViewNetWorth(session.user)) return;

  const account = await db.account.findUnique({ where: { id: accountId } });
  if (!belongsToHousehold(account, session.user.householdId)) return;
  if (account.accountType !== "CHECKING" && account.accountType !== "SAVINGS") return;

  await db.account.update({ where: { id: accountId }, data: { excludedFromNetWorth: true } });
  revalidatePath("/networth");
}

export async function includeCashAccount(accountId: string) {
  const session = await auth();
  if (!session?.user) redirect("/login");
  if (!canViewNetWorth(session.user)) return;

  const account = await db.account.findUnique({ where: { id: accountId } });
  if (!belongsToHousehold(account, session.user.householdId)) return;

  await db.account.update({ where: { id: accountId }, data: { excludedFromNetWorth: false } });
  revalidatePath("/networth");
}

export async function linkAssetAccount(assetId: string, accountId: string) {
  const session = await auth();
  if (!session?.user) redirect("/login");
  if (!canViewNetWorth(session.user)) return;

  const asset = await db.asset.findUnique({ where: { id: assetId } });
  if (!belongsToHousehold(asset, session.user.householdId)) return;

  if (!accountId) {
    await db.asset.update({ where: { id: assetId }, data: { accountId: null, source: "MANUAL" } });
    revalidatePath("/networth");
    return;
  }

  const account = await db.account.findUnique({ where: { id: accountId } });
  if (!belongsToHousehold(account, session.user.householdId)) return;
  // A LOAN account's balance is what's owed, not what the collateral is
  // worth — linking a HOME_EQUITY/VEHICLE_EQUITY asset to one would silently
  // zero out its value (Math.max(negative-owed-balance, 0) === 0). Only an
  // INVESTMENT account's balance is ever a legitimate stand-in for an
  // asset's current value. The UI already restricts the dropdown to
  // INVESTMENT accounts; this is the server-side backstop.
  if (account.accountType !== "INVESTMENT") return;

  await db.asset.update({
    where: { id: assetId },
    data: {
      accountId,
      source: "SIMPLEFIN",
      valueCents: Math.max(account.balanceCents, 0),
      asOfDate: todayAsUTCDate(), // @db.Date — the local calendar day, not a raw UTC instant
    },
  });
  revalidatePath("/networth");
}

// Points a HOME_EQUITY/VEHICLE_EQUITY asset at the mortgage/auto loan Debt
// that secures it, so its condensed row can show equity (value - balance)
// instead of full value. Debt.balanceCents already flows into net worth's
// total on its own — this link only changes what a single row displays.
export async function linkAssetDebt(assetId: string, debtId: string) {
  const session = await auth();
  if (!session?.user) redirect("/login");
  if (!canViewNetWorth(session.user)) return;

  const asset = await db.asset.findUnique({ where: { id: assetId } });
  if (!belongsToHousehold(asset, session.user.householdId)) return;
  if (asset.assetType !== "HOME_EQUITY" && asset.assetType !== "VEHICLE_EQUITY") return;

  if (!debtId) {
    await db.asset.update({ where: { id: assetId }, data: { debtId: null } });
    revalidatePath("/networth");
    return;
  }

  const debt = await db.debt.findUnique({ where: { id: debtId } });
  if (!belongsToHousehold(debt, session.user.householdId)) return;

  // Asset.debtId is @unique — one debt secures at most one asset. The UI
  // dropdown already excludes debts linked elsewhere; this is the
  // server-side backstop (mirrors linkAssetAccount's INVESTMENT-only check).
  const alreadyLinked = await db.asset.findUnique({ where: { debtId }, select: { id: true } });
  if (alreadyLinked && alreadyLinked.id !== assetId) return;

  await db.asset.update({ where: { id: assetId }, data: { debtId } });
  revalidatePath("/networth");
}

const createLinkedDebtSchema = z.object({
  name: z.string().trim().min(1).max(80),
  balance: z.string(),
  apr: z.string(),
  minPayment: z.string(),
});

// Percent input, tolerant of a trailing "%" — same parsing rule as
// parseAprToBasisPoints in debts/actions.ts, duplicated here (3 lines,
// deliberately not shared) rather than importing across features for it.
function parseAprPercentToBasisPoints(apr: string): number | null {
  const value = Number(apr.replace(/%/g, "").trim());
  if (!Number.isFinite(value) || value < 0 || value > 100) return null;
  return Math.round(value * 100);
}

export type CreateLinkedDebtState = { error?: string };

// For a loan whose lender doesn't sync with SimpleFIN at all (Tesla
// Financial, a private/family loan, etc.) — creates a plain manual Debt
// (same REVOLVING shape "Add a debt" on /debts creates) and links it to
// this asset in one step, instead of sending the household to /debts to
// create it and back here to link it.
export async function createLinkedDebt(
  assetId: string,
  _prev: CreateLinkedDebtState,
  formData: FormData,
): Promise<CreateLinkedDebtState> {
  const session = await auth();
  if (!session?.user) redirect("/login");
  if (!canViewNetWorth(session.user)) return { error: "Not authorized." };

  const asset = await db.asset.findUnique({ where: { id: assetId } });
  if (!belongsToHousehold(asset, session.user.householdId)) return { error: "Not found." };
  if (asset.assetType !== "HOME_EQUITY" && asset.assetType !== "VEHICLE_EQUITY") {
    return { error: "Not applicable to this asset type." };
  }

  const parsed = createLinkedDebtSchema.safeParse({
    name: formData.get("name"),
    balance: formData.get("balance"),
    apr: formData.get("apr"),
    minPayment: formData.get("minPayment"),
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input" };

  const balanceCents = parseDollarsToCents(parsed.data.balance);
  const minPaymentCents = parseDollarsToCents(parsed.data.minPayment);
  const aprBasisPoints = parseAprPercentToBasisPoints(parsed.data.apr);
  if (balanceCents === null || minPaymentCents === null || aprBasisPoints === null) {
    return { error: "Enter a valid balance, APR, and minimum payment." };
  }

  const debt = await db.debt.create({
    data: {
      householdId: session.user.householdId,
      name: parsed.data.name,
      debtType: "REVOLVING",
      balanceCents,
      aprBasisPoints,
      minPaymentCents,
    },
  });

  await db.asset.update({ where: { id: assetId }, data: { debtId: debt.id } });

  revalidatePath("/networth");
  revalidatePath("/debts");
  return {};
}

const updateValueSchema = z.object({
  name: z.string().trim().min(1).max(80),
  value: z.string(),
  asOfDate: z.string(),
});

export type UpdateAssetValueState = { error?: string };

// Home/vehicle equity has no bank-syncable "current value" (see
// linkAssetAccount) — this is the only way those ever get updated, so it
// has to work on any MANUAL asset, not just at creation. Blocked for a
// SIMPLEFIN-linked asset since the next sync would just overwrite it anyway.
export async function updateAssetValue(
  assetId: string,
  _prev: UpdateAssetValueState,
  formData: FormData,
): Promise<UpdateAssetValueState> {
  const session = await auth();
  if (!session?.user) redirect("/login");
  if (!canViewNetWorth(session.user)) return { error: "Not authorized." };

  const asset = await db.asset.findUnique({ where: { id: assetId } });
  if (!belongsToHousehold(asset, session.user.householdId)) return { error: "Not found." };
  if (asset.source === "SIMPLEFIN") return { error: "This value syncs automatically — unlink it first." };

  const parsed = updateValueSchema.safeParse({
    name: formData.get("name"),
    value: formData.get("value"),
    asOfDate: formData.get("asOfDate"),
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input" };

  const valueCents = parseDollarsToCents(parsed.data.value);
  if (valueCents === null) return { error: "Enter a valid value." };

  const asOfDate = new Date(parsed.data.asOfDate);
  if (Number.isNaN(asOfDate.getTime())) return { error: "Enter a valid date." };

  await db.asset.update({
    where: { id: assetId },
    data: {
      name: parsed.data.name,
      valueCents,
      asOfDate,
      source: "MANUAL",
      // A manual figure is authoritative for the rest of this month — stamp
      // this so refreshStaleAssetEstimates doesn't immediately overwrite it
      // on the next page load (only relevant if this asset has estimate
      // details set; harmless no-op otherwise).
      estimateUpdatedAt: asset.estimateDetails ? new Date() : asset.estimateUpdatedAt,
    },
  });
  revalidatePath("/networth");
  return {};
}

// One-click "still accurate, nothing changed" for a stale MANUAL asset (see
// isAssetStale/STALE_ASSET_MONTHS in networth.ts) — just restamps asOfDate
// to today without touching valueCents, distinct from updateAssetValue's
// full edit. Not offered for SIMPLEFIN/AI_ESTIMATE/LIVE_PRICE sources: those
// already restamp asOfDate on their own (sync/monthly re-estimate/every page
// load), so a stale one means that automatic refresh is failing — the fix
// there is the Sparkles re-run button, not a manual attestation.
export async function confirmAssetValue(assetId: string) {
  const session = await auth();
  if (!session?.user) redirect("/login");
  if (!canViewNetWorth(session.user)) return;

  const asset = await db.asset.findUnique({ where: { id: assetId } });
  if (!belongsToHousehold(asset, session.user.householdId)) return;
  if (asset.source !== "MANUAL") return;

  await db.asset.update({ where: { id: assetId }, data: { asOfDate: todayAsUTCDate() } });
  revalidatePath("/networth");
}

export async function deleteAsset(assetId: string) {
  const session = await auth();
  if (!session?.user) redirect("/login");
  if (!canViewNetWorth(session.user)) return;

  const asset = await db.asset.findUnique({ where: { id: assetId } });
  if (!belongsToHousehold(asset, session.user.householdId)) return;

  await db.asset.delete({ where: { id: assetId } });
  revalidatePath("/networth");
}

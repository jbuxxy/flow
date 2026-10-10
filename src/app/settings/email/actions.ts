"use server";

import { z } from "zod";
import { db } from "@/lib/db";
import { requireFullAccess, belongsToHousehold } from "@/lib/access";
import { encrypt, decrypt } from "@/lib/crypto";
import { verifyEmailConfig } from "@/lib/email-provider";
import { runFullScan } from "@/lib/receipt-sync";
import { applyBillNoticeMatch, dismissBillNoticeEmail } from "@/lib/bill-notice-sync";
import { revalidateHousehold } from "@/lib/revalidate";

// Any full-access member manages their OWN mailbox connection(s) (same bar
// as Income — a Partner already sees the underlying transactions). Not
// owner-only: the credential is the member's own, and their receipts are
// just as useful to the household budget as the owner's. A member can
// connect more than one inbox (household request, 2026-09-11) — every
// action below takes a connectionId and re-checks it belongs to the calling
// user, rather than assuming "the" connection the way this file used to
// when EmailConnection.userId was unique.

export type EmailSettingsState = { error?: string };

const connectSchema = z.object({
  imapHost: z.string().trim().min(1).max(255),
  imapPort: z.coerce.number().int().min(1).max(65535),
  imapUser: z.string().trim().min(1).max(320),
  imapPassword: z.string().min(1).max(1024),
  consent: z.literal("on"),
});

// New connection (no connectionId) or replacing one connection's own
// credential in place (connectionId set — "Replace App Password"/"Fix
// Connection" on an existing row keeps its receipt history and sync cursors,
// just re-authenticates). Never upserts by userId anymore — a household
// member can have several rows, so there's no single "the" row to upsert.
export async function connectEmail(
  connectionId: string | null,
  _prev: EmailSettingsState,
  formData: FormData,
): Promise<EmailSettingsState> {
  const session = await requireFullAccess();

  const parsed = connectSchema.safeParse({
    imapHost: formData.get("imapHost"),
    imapPort: formData.get("imapPort") || 993,
    imapUser: formData.get("imapUser"),
    imapPassword: formData.get("imapPassword"),
    consent: formData.get("consent"),
  });
  if (!parsed.success) {
    const consentIssue = parsed.error.issues.some((i) => i.path[0] === "consent");
    return {
      error: consentIssue
        ? "Please confirm you're okay with receipt/bill-amount emails being sent to your AI provider for parsing."
        : "Fill in your mail server, username, and app password.",
    };
  }

  const config = {
    host: parsed.data.imapHost,
    port: parsed.data.imapPort,
    user: parsed.data.imapUser,
    password: parsed.data.imapPassword,
  };

  // Real login before persisting — a wrong app password should never be
  // reported as "connected" (same convention as saveAiSettings).
  const verifyError = await verifyEmailConfig(config);
  if (verifyError) return { error: `Couldn't sign in to that mailbox: ${verifyError}` };

  if (connectionId) {
    const existing = await db.emailConnection.findUnique({ where: { id: connectionId } });
    if (!existing || existing.userId !== session.user.id) return { error: "Connection not found." };
    await db.emailConnection.update({
      where: { id: connectionId },
      data: {
        imapHost: config.host,
        imapPort: config.port,
        imapUser: config.user,
        imapPasswordEncrypted: encrypt(config.password),
        status: "ACTIVE",
        lastError: null,
        aiConsentAt: new Date(),
      },
    });
  } else {
    await db.emailConnection.create({
      data: {
        userId: session.user.id,
        householdId: session.user.householdId,
        imapHost: config.host,
        imapPort: config.port,
        imapUser: config.user,
        imapPasswordEncrypted: encrypt(config.password),
        status: "ACTIVE",
        lastError: null,
        aiConsentAt: new Date(),
      },
    });
  }

  revalidateHousehold();
  return {};
}

// Manual "check my inbox now" — every one of the member's connections, not
// just one. Fire-and-forget: the full scan (90-day first fetch + AI
// extraction + match + re-categorize) runs for minutes, well past a proxy
// timeout, so this kicks it off and returns — the panel polls
// /api/settings/email/scan-status for progress and completion.
export async function scanMyEmailNow() {
  const session = await requireFullAccess();
  const householdId = session.user.householdId;

  const connected = await db.emailConnection.findFirst({
    where: { userId: session.user.id },
    select: { id: true },
  });
  if (!connected) return;

  void runFullScan(householdId);
}

// Shared with the poll route (src/app/api/settings/email/scan-status/route.ts)
// — the panel polls that, not a server action, because Next queues server
// actions one-at-a-time and a status poll would block behind the long
// scanMyEmailNow it's meant to report on.
export type ReceiptScanStatus = {
  connected: boolean;
  scanning: boolean;
  parsedCount: number;
  awaitingCount: number;
  lastPolledAt: string | null;
};

export async function disconnectEmail(connectionId: string) {
  const session = await requireFullAccess();
  // Deletes the row → cascades its Receipt rows. Transaction enrichment
  // (resolvedMerchant / receiptItems / receiptTotalCents) is on the
  // transaction itself and is deliberately left intact. deleteMany (not
  // delete) so an already-gone/already-someone-else's id is a silent no-op
  // rather than a thrown NotFoundError — same ownership-scoped-in-the-where
  // convention as every other action here.
  await db.emailConnection.deleteMany({ where: { id: connectionId, userId: session.user.id } });
  revalidateHousehold();
}

// A member's manual "try my connection again now" for a row sitting in
// ERROR — re-runs the same real login verifyEmailConfig does at save time
// against the already-stored password, mirroring retestAiConnection.
export async function retestEmailConnection(connectionId: string) {
  const session = await requireFullAccess();

  const existing = await db.emailConnection.findUnique({ where: { id: connectionId } });
  if (!existing || existing.userId !== session.user.id) return;

  let password: string;
  try {
    password = decrypt(existing.imapPasswordEncrypted);
  } catch (err) {
    await db.emailConnection.update({
      where: { id: connectionId },
      data: {
        status: "ERROR",
        lastError: err instanceof Error ? err.message : "Stored password could not be decrypted.",
      },
    });
    revalidateHousehold();
    return;
  }

  const verifyError = await verifyEmailConfig({
    host: existing.imapHost,
    port: existing.imapPort,
    user: existing.imapUser,
    password,
  });
  await db.emailConnection.update({
    where: { id: connectionId },
    data: { status: verifyError ? "ERROR" : "ACTIVE", lastError: verifyError },
  });

  revalidateHousehold();
}

// Manual half of bill-notice matching (see matchBillNoticeAmounts,
// src/lib/bill-notice-sync.ts) for a notice it couldn't place on its own —
// same "which one is this?" picker pattern as ReceiptLinker, routed through
// the same applyBillNoticeMatch helper the automatic pass uses so a manual
// link produces a review (or NO_CHANGE) identically.
export async function linkBillNoticeToBill(
  noticeId: string,
  billId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const session = await requireFullAccess();

  const [notice, bill] = await Promise.all([
    db.billNoticeEmail.findUnique({ where: { id: noticeId } }),
    db.recurringBill.findUnique({ where: { id: billId } }),
  ]);
  if (!belongsToHousehold(notice, session.user.householdId)) return { ok: false, error: "That notice is no longer available." };
  if (!belongsToHousehold(bill, session.user.householdId)) return { ok: false, error: "That bill is no longer available." };

  await applyBillNoticeMatch(notice, { type: "BILL", id: bill.id });

  revalidateHousehold();
  return { ok: true };
}

export async function linkBillNoticeToDebt(
  noticeId: string,
  debtId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const session = await requireFullAccess();

  const [notice, debt] = await Promise.all([
    db.billNoticeEmail.findUnique({ where: { id: noticeId } }),
    db.debt.findUnique({ where: { id: debtId } }),
  ]);
  if (!belongsToHousehold(notice, session.user.householdId)) return { ok: false, error: "That notice is no longer available." };
  if (!belongsToHousehold(debt, session.user.householdId)) return { ok: false, error: "That debt is no longer available." };

  await applyBillNoticeMatch(notice, { type: "DEBT", id: debt.id });

  revalidateHousehold();
  return { ok: true };
}

// Household says "not one I track" — excludes it from matching, purged on
// the next sweep (see purgeStaleBillNotices).
export async function dismissBillNotice(noticeId: string): Promise<void> {
  const session = await requireFullAccess();

  const notice = await db.billNoticeEmail.findUnique({ where: { id: noticeId } });
  if (!belongsToHousehold(notice, session.user.householdId)) return;

  await dismissBillNoticeEmail(noticeId);
  revalidateHousehold();
}

import { generateSecret, generateURI, verify } from "otplib";
import QRCode from "qrcode";
import { db } from "@/lib/db";

export function generateTotpSecret(): string {
  return generateSecret();
}

// The time step the code matched, or null. `afterTimeStep` rejects any code
// at or before that step (otplib's own replay guard).
export async function verifyTotpCode(
  secret: string,
  code: string,
  afterTimeStep?: number | null,
): Promise<number | null> {
  try {
    const result = await verify({
      secret,
      token: code,
      epochTolerance: 30,
      ...(afterTimeStep != null ? { afterTimeStep } : {}),
    });
    return result.valid && "timeStep" in result ? result.timeStep : null;
  } catch {
    return null;
  }
}

// Verifies a code and atomically records its time step as used, so the same
// code can't sign in twice within its ~1-minute validity window — not by a
// replay, and not by two requests racing each other (the conditional update
// only lets one of them claim the step). Every TOTP check goes through here.
export async function claimTotpCode(
  user: { id: string; totpLastTimeStep: number | null },
  secret: string,
  code: string,
): Promise<boolean> {
  const step = await verifyTotpCode(secret, code, user.totpLastTimeStep);
  if (step === null) return false;
  const { count } = await db.user.updateMany({
    where: {
      id: user.id,
      OR: [{ totpLastTimeStep: null }, { totpLastTimeStep: { lt: step } }],
    },
    data: { totpLastTimeStep: step },
  });
  return count === 1;
}

export async function totpQrCodeDataUrl(
  secret: string,
  accountEmail: string,
): Promise<string> {
  const otpauth = generateURI({
    issuer: "Flow",
    label: accountEmail,
    secret,
  });
  return QRCode.toDataURL(otpauth);
}

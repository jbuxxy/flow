import { generateSecret, generateURI, verify } from "otplib";
import QRCode from "qrcode";

export function generateTotpSecret(): string {
  return generateSecret();
}

export async function verifyTotpCode(
  secret: string,
  code: string,
): Promise<boolean> {
  try {
    const result = await verify({ secret, token: code, epochTolerance: 30 });
    return result.valid;
  } catch {
    return false;
  }
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

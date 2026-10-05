import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { verifySetupToken } from "@/lib/setup-token";
import { encrypt } from "@/lib/crypto";
import { generateTotpSecret, totpQrCodeDataUrl } from "@/lib/totp";
import { GeometricBackground } from "@/components/geometric-background";
import { SetupLinkExpired } from "@/components/setup-link-expired";
import { TotpForm } from "./totp-form";
import { AccountDetailsForm } from "./account-details-form";

export default async function SetupTotpPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;
  if (!token) redirect("/login");

  const verified = verifySetupToken(token);
  if (!verified) {
    return <SetupLinkExpired />;
  }

  const user = await db.user.findUnique({ where: { id: verified.userId } });
  if (!user) redirect("/login");

  // This one link carries an invitee through up to two steps, purely driven
  // by the user's own current DB state (no separate "which step" param to
  // drift out of sync) — see setAccountDetails's own comment for why it
  // redirects back here instead of rendering the next step itself.
  // Step 1: no name/email/password yet (invited via inviteHouseholdMember,
  // which deliberately leaves all three unset — see the schema's own
  // comment — the owner only picked an access level). All three are set
  // together in setAccountDetails, so checking passwordHash here is enough
  // to gate the step, but including email/name too lets TypeScript narrow
  // them to non-null for the rest of this function.
  if (!user.passwordHash || !user.email || !user.name) {
    return (
      <main className="relative mx-auto flex min-h-dvh max-w-sm flex-col justify-center gap-6 overflow-hidden px-4">
        <GeometricBackground />
        <div className="relative flex flex-col gap-6">
          <div>
            <h1 className="text-2xl font-bold text-blue-900 dark:text-blue-300">Join the Household</h1>
            <p className="mt-1 text-sm text-gray-500 dark:text-neutral-400">
              {user.role === "CHILD"
                ? "Set up your account to finish joining the household."
                : "Set up your account, then you'll set up two-factor login."}
            </p>
          </div>
          <AccountDetailsForm token={token} />
        </div>
      </main>
    );
  }

  // Step 2 (OWNER/PARENT only — CHILD's setAccountPassword redirects
  // straight to login instead of back here, nothing left for them to do):
  // password is set, TOTP isn't yet.
  if (user.role === "CHILD" || user.totpEnabled) {
    redirect("/login?enrolled=1");
  }

  let secretEncrypted = user.totpSecretEncrypted;
  if (!secretEncrypted) {
    const secret = generateTotpSecret();
    secretEncrypted = encrypt(secret);
    await db.user.update({
      where: { id: user.id },
      data: { totpSecretEncrypted: secretEncrypted },
    });
  }

  const { decrypt } = await import("@/lib/crypto");
  const secret = decrypt(secretEncrypted);
  const qrDataUrl = await totpQrCodeDataUrl(secret, user.email);

  return (
    <main className="relative mx-auto flex min-h-dvh max-w-sm flex-col justify-center gap-6 overflow-hidden px-4">
      <GeometricBackground />
      <div className="relative flex flex-col gap-6">
        <div>
          <h1 className="text-2xl font-bold text-blue-900 dark:text-blue-300">Set Up Two-Factor Login</h1>
          <p className="mt-1 text-sm text-gray-500 dark:text-neutral-400">
            Scan this with an authenticator app (Google Authenticator,
            1Password, etc.), then enter the 6-digit code it shows.
          </p>
        </div>

        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={qrDataUrl}
          alt="Scan with your authenticator app"
          className="mx-auto h-48 w-48 rounded-lg border border-blue-100 dark:border-neutral-800"
        />

        <details className="text-xs text-gray-500 dark:text-neutral-400">
          <summary className="cursor-pointer">Can&apos;t scan? Enter manually</summary>
          <code className="mt-1 block break-all">{secret}</code>
        </details>

        <TotpForm token={token} />
      </div>
    </main>
  );
}

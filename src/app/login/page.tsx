"use client";

import { useState, useRef, useTransition, Suspense } from "react";
import Image from "next/image";
import { useRouter, useSearchParams } from "next/navigation";
import { signIn } from "next-auth/react";
import { ScanFace } from "lucide-react";
import { GeometricBackground } from "@/components/geometric-background";
import { Modal } from "@/components/modal";
import { PasswordInput } from "@/components/password-input";
import { precheckLogin } from "./actions";
import { signInWithPasskey, registerPasskey } from "@/lib/webauthn-client";

// Top-level choice: "passkey" (the default landing view — a fully
// passwordless, discoverable-credential sign-in, no email typed at all) or
// "password" (the fallback: email + password, + a TOTP code for anyone
// who's enrolled — unchanged from before passkeys existed, still how a
// first sign-in on a new device or an account with no passkey works).
type Mode = "passkey" | "password";
// Once in password mode, the modal step: "totp" is the code entry; "setup-
// offer" is a one-time nudge shown right after a totp-path sign-in
// succeeds, for an account that hasn't registered a passkey at all — so
// enrolling one doesn't require a separate trip through Settings.
type PasswordStep = "credentials" | "totp" | "setup-offer";

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const next = searchParams.get("callbackUrl") ?? "/";
  // /setup-totp redirects here with ?enrolled=1 right after TOTP enrollment
  // finishes — a provably brand-new account that can't possibly have a
  // passkey registered yet (registering one needs an authenticated session,
  // which requires this exact login first). Landing them on "Sign In with
  // Passkey" anyway would just fail with nothing to find and make them hunt
  // for the fallback link (household report, 2026-09-11). Every OTHER visit
  // still defaults to passkey-first.
  const isFreshEnrollment = searchParams.get("enrolled") === "1";

  const [mode, setMode] = useState<Mode>(isFreshEnrollment ? "password" : "passkey");
  const [passkeyPending, startPasskeyTransition] = useTransition();
  const [passkeyError, setPasskeyError] = useState<string | null>(null);

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [totpCode, setTotpCode] = useState("");
  const [step1Error, setStep1Error] = useState<string | null>(null);
  const [totpError, setTotpError] = useState<string | null>(null);
  const [passwordStep, setPasswordStep] = useState<PasswordStep>("credentials");
  const [setupResult, setSetupResult] = useState<string | null>(null);
  // precheckLogin's offerPasskeySetup only matters once the totp step
  // actually succeeds, several renders (and an async signIn call) later —
  // a ref carries it across that without threading one more piece of state
  // through onStep1Submit/onTotpSubmit.
  const offerPasskeySetupRef = useRef(false);

  const [step1Pending, startStep1Transition] = useTransition();
  const [totpPending, startTotpTransition] = useTransition();
  const [setupPending, startSetupTransition] = useTransition();
  const [demoPending, startDemoTransition] = useTransition();

  const modalOpen = passwordStep === "totp" || passwordStep === "setup-offer";

  function closeModal() {
    // A session already exists by the time "setup-offer" shows — closing
    // it (Escape / the X / clicking the backdrop) has to still finish the
    // navigation, same as "Maybe Later", or the app would sit re-rendering
    // the login form under an already-signed-in session.
    if (passwordStep === "setup-offer") {
      onSkipSetup();
      return;
    }
    setPasswordStep("credentials");
  }

  function onDemoClick() {
    setStep1Error(null);
    startDemoTransition(async () => {
      const res = await signIn("credentials", { demo: "1", redirect: false });
      if (res?.error) {
        setStep1Error("The example household is unavailable right now.");
        return;
      }
      router.push("/");
      router.refresh();
    });
  }

  function onPasskeySignIn() {
    setPasskeyError(null);
    startPasskeyTransition(async () => {
      const result = await signInWithPasskey();
      if (!result.ok) {
        // A cancelled prompt (including "no passkey found on this device")
        // isn't an error worth alarming over — they can just try the
        // password path instead, the link is right there.
        setPasskeyError(result.cancelled ? null : result.error);
        return;
      }
      const res = await signIn("credentials", {
        webauthnToken: result.value.webauthnToken,
        redirect: false,
      });
      if (res?.error) {
        setPasskeyError("That passkey didn't complete sign-in. Try again or use your password.");
        return;
      }
      router.push(next);
      router.refresh();
    });
  }

  function onStep1Submit(formData: FormData) {
    setStep1Error(null);
    const emailValue = String(formData.get("email") ?? "");
    const passwordValue = String(formData.get("password") ?? "");
    startStep1Transition(async () => {
      const result = await precheckLogin(emailValue, passwordValue);
      if (!result.ok) {
        setStep1Error(result.error);
        return;
      }
      setEmail(emailValue);
      setPassword(passwordValue);
      setTotpCode("");
      setTotpError(null);
      offerPasskeySetupRef.current = result.offerPasskeySetup;
      setPasswordStep("totp");
    });
  }

  function onTotpSubmit(formData: FormData) {
    setTotpError(null);
    const code = String(formData.get("totpCode") ?? "");
    startTotpTransition(async () => {
      const res = await signIn("credentials", {
        email,
        password,
        totpCode: code,
        redirect: false,
      });
      if (res?.error) {
        setTotpError("Wrong code. Check your authenticator app and try again.");
        return;
      }
      if (offerPasskeySetupRef.current) {
        setPasswordStep("setup-offer");
        return;
      }
      setPasswordStep("credentials");
      router.push(next);
      router.refresh();
    });
  }

  function onSetUpPasskeyClick() {
    startSetupTransition(async () => {
      const result = await registerPasskey();
      setSetupResult(result.ok ? `Saved as "${result.value.nickname}."` : null);
      // Whether it worked or the person backed out, finish signing in
      // either way — this is a convenience offer, never a gate.
      setTimeout(
        () => {
          setPasswordStep("credentials");
          router.push(next);
          router.refresh();
        },
        result.ok ? 900 : 0,
      );
    });
  }

  function onSkipSetup() {
    setPasswordStep("credentials");
    router.push(next);
    router.refresh();
  }

  return (
    <main className="relative flex min-h-dvh flex-col items-center justify-center overflow-hidden px-4">
      <GeometricBackground />

      <div className="relative flex w-full max-w-sm flex-col items-center gap-1 text-center">
        <Image src="/icons/flow-mark.png" alt="" width={256} height={189} className="mb-1 h-28 w-auto" priority />
        <Image src="/icons/flowText.png" alt="flow" width={269} height={104} className="mb-2 h-10 w-auto" priority />
        <p className="mt-1 text-sm text-gray-500 dark:text-neutral-400">Sign in to your household.</p>

        {mode === "passkey" ? (
          <div className="mt-6 flex w-full flex-col gap-3">
            <button
              type="button"
              onClick={onPasskeySignIn}
              disabled={passkeyPending}
              className="flex items-center justify-center gap-2 rounded-lg bg-blue-900 dark:bg-blue-700 px-4 py-3 font-medium text-white disabled:opacity-50"
            >
              <ScanFace size={20} />
              {passkeyPending ? "Waiting…" : "Sign In with Passkey"}
            </button>
            <p className="text-xs text-gray-500 dark:text-neutral-400">
              Face ID, Touch ID, or Windows Hello — whatever this device uses.
            </p>
            {passkeyError && (
              <p className="text-sm text-red-600 dark:text-red-400" role="alert">
                {passkeyError}
              </p>
            )}
            <button
              type="button"
              onClick={() => {
                setPasskeyError(null);
                setMode("password");
              }}
              className="mt-1 text-sm text-blue-900 dark:text-blue-300 underline underline-offset-2"
            >
              Sign In with Password Instead
            </button>
          </div>
        ) : (
          <>
            <form action={onStep1Submit} className="mt-6 flex w-full flex-col gap-4 text-left">
              <label className="flex flex-col gap-1.5 text-sm font-medium">
                Email
                <input
                  name="email"
                  type="email"
                  required
                  autoComplete="email"
                  autoFocus
                  className="rounded-lg border border-neutral-300 dark:border-neutral-700 bg-[var(--background)] px-3 py-2.5 text-base font-normal focus:border-blue-900 focus:outline-none"
                />
              </label>

              <label className="flex flex-col gap-1.5 text-sm font-medium">
                Password
                <PasswordInput name="password" required autoComplete="current-password" />
              </label>

              {step1Error && (
                <p className="text-sm text-red-600 dark:text-red-400" role="alert">
                  {step1Error}
                </p>
              )}

              <button
                type="submit"
                disabled={step1Pending}
                className="mt-2 rounded-lg bg-blue-900 dark:bg-blue-700 px-4 py-2.5 font-medium text-white disabled:opacity-50"
              >
                {step1Pending ? "Checking…" : "Continue"}
              </button>
            </form>
            <button
              type="button"
              onClick={() => {
                setStep1Error(null);
                setMode("passkey");
              }}
              className="mt-3 text-sm text-blue-900 dark:text-blue-300 underline underline-offset-2"
            >
              Sign In with a Passkey Instead
            </button>
          </>
        )}

        <div className="mt-6 flex w-full flex-col items-center gap-2">
          <div className="flex w-full items-center gap-3 text-xs text-gray-400 dark:text-neutral-600">
            <span className="h-px flex-1 bg-current" />
            new here?
            <span className="h-px flex-1 bg-current" />
          </div>
          <button
            type="button"
            onClick={onDemoClick}
            disabled={demoPending}
            className="rounded-lg border border-blue-900/30 dark:border-blue-300/30 px-4 py-2.5 text-sm font-medium text-blue-900 dark:text-amber-400 disabled:opacity-50"
          >
            {demoPending ? "Loading…" : "View the Example Household"}
          </button>
          <p className="text-xs text-gray-500 dark:text-neutral-400">A read-only tour with sample data.</p>
        </div>
      </div>

      <Modal
        open={modalOpen}
        onClose={closeModal}
        title={passwordStep === "setup-offer" ? "Set Up Face ID?" : "Enter Your Authenticator Code"}
      >
        {passwordStep === "totp" && (
          <form action={onTotpSubmit} className="flex flex-col gap-4">
            <p className="text-sm text-gray-500 dark:text-neutral-400">
              Open your authenticator app and enter the 6-digit code for {email}.
            </p>
            <label className="flex flex-col gap-1.5 text-sm font-medium">
              Authenticator Code
              <input
                name="totpCode"
                type="text"
                inputMode="numeric"
                pattern="\d{6}"
                maxLength={6}
                autoComplete="one-time-code"
                autoFocus
                value={totpCode}
                onChange={(e) => setTotpCode(e.target.value)}
                className="rounded-lg border border-neutral-300 dark:border-neutral-700 bg-[var(--background)] px-3 py-2.5 text-base font-normal tracking-widest focus:border-blue-900 focus:outline-none"
              />
            </label>

            {totpError && (
              <p className="text-sm text-red-600 dark:text-red-400" role="alert">
                {totpError}
              </p>
            )}

            <button
              type="submit"
              disabled={totpPending}
              className="rounded-lg bg-blue-900 dark:bg-blue-700 px-4 py-2.5 font-medium text-white disabled:opacity-50"
            >
              {totpPending ? "Signing In…" : "Sign In"}
            </button>
          </form>
        )}

        {passwordStep === "setup-offer" && (
          <div className="flex flex-col gap-4">
            <p className="text-sm text-gray-500 dark:text-neutral-400">
              Skip the password and authenticator code next time — sign in with Face ID, Touch ID, or
              Windows Hello instead. You can always add or remove one later in Settings.
            </p>
            {setupResult && (
              <p className="text-sm text-emerald-700 dark:text-emerald-400" role="status">
                {setupResult}
              </p>
            )}
            <button
              type="button"
              onClick={onSetUpPasskeyClick}
              disabled={setupPending || setupResult !== null}
              className="flex items-center justify-center gap-2 rounded-lg bg-blue-900 dark:bg-blue-700 px-4 py-3 font-medium text-white disabled:opacity-50"
            >
              <ScanFace size={20} />
              {setupPending ? "Setting Up…" : "Set Up Now"}
            </button>
            <button
              type="button"
              onClick={onSkipSetup}
              disabled={setupPending}
              className="text-sm text-gray-500 dark:text-neutral-400 underline underline-offset-2 disabled:opacity-50"
            >
              Maybe Later
            </button>
          </div>
        )}
      </Modal>
    </main>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}

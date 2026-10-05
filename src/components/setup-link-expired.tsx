// Shared between /invite/[code] and /setup-totp — both resolve to the same
// "nothing usable here" state (an unknown/already-used invite code, or an
// expired/malformed setup token) and say so identically rather than each
// hand-rolling its own wording.
export function SetupLinkExpired() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center gap-4 px-4 text-center">
      <h1 className="text-xl font-semibold">Setup Link Expired</h1>
      <p className="text-sm text-gray-500 dark:text-neutral-400">
        This setup link is no longer valid. Ask whoever invited you for a
        new one, or sign in if you&apos;ve already finished setup.
      </p>
    </main>
  );
}

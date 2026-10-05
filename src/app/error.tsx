"use client";

import { signOut } from "next-auth/react";
import { AlertTriangle } from "lucide-react";

// App-wide fallback for an uncaught error anywhere under the root layout.
// Added 2026-09-28 after the monthly demo-household refresh (src/scripts/
// seed-demo.ts --auto) deleted and recreated Household.isDemo mid-session:
// every page unconditionally trusts session.user.householdId (baked into
// the JWT at sign-in, never re-validated — see auth.config.ts's jwt/session
// callbacks) and does a `findUniqueOrThrow` against it, so a session left
// open across that recreation 500'd on every reload with no way out —
// reloading re-sends the same stale cookie. Signing out clears it and gets
// a fresh session on next login; a plain "Try Again" alone wouldn't have.
export default function Error({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="flex min-h-[70vh] flex-col items-center justify-center px-4 text-center">
      <div className="w-full max-w-sm rounded-2xl border border-red-200 bg-white p-6 shadow-sm dark:border-red-900/50 dark:bg-neutral-900">
        <AlertTriangle className="mx-auto mb-3 text-red-700 dark:text-red-400" size={32} />
        <h1 className="font-comfortaa text-lg font-bold text-red-700 dark:text-red-400">Something Went Wrong</h1>
        <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-400">
          If this keeps happening after signing out and back in, the household
          this session points at may no longer exist.
        </p>
        <div className="mt-5 flex flex-col gap-2">
          <button
            onClick={() => signOut({ redirectTo: "/login" })}
            className="rounded-lg bg-blue-900 px-4 py-2 text-sm font-medium text-white hover:bg-blue-800 dark:bg-blue-700 dark:hover:bg-blue-600"
          >
            Sign Out And Try Again
          </button>
          <button
            onClick={() => reset()}
            className="rounded-lg border border-neutral-300 px-4 py-2 text-sm font-medium text-neutral-700 hover:bg-neutral-50 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
          >
            Try Again
          </button>
        </div>
      </div>
    </div>
  );
}

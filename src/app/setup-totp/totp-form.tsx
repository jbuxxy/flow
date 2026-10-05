"use client";

import { useActionState } from "react";
import { verifyTotpEnrollment, type TotpVerifyState } from "./actions";

const initialState: TotpVerifyState = {};

export function TotpForm({ token }: { token: string }) {
  const [state, formAction, pending] = useActionState(
    verifyTotpEnrollment,
    initialState,
  );

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <input type="hidden" name="token" value={token} />
      <label className="flex flex-col gap-1.5 text-sm font-medium">
        6-Digit Code
        <input
          name="code"
          type="text"
          inputMode="numeric"
          pattern="\d{6}"
          maxLength={6}
          required
          autoFocus
          autoComplete="one-time-code"
          className="rounded-lg border border-neutral-300 dark:border-neutral-700 px-3 py-2.5 text-center text-lg tracking-[0.5em] focus:border-blue-900 focus:outline-none"
        />
      </label>

      {state.error && (
        <p className="text-sm text-red-600 dark:text-red-400" role="alert">
          {state.error}
        </p>
      )}

      <button
        type="submit"
        disabled={pending}
        className="rounded-lg bg-blue-900 dark:bg-blue-700 px-4 py-2.5 font-medium text-white disabled:opacity-50"
      >
        {pending ? "Verifying…" : "Confirm and Finish Setup"}
      </button>
    </form>
  );
}

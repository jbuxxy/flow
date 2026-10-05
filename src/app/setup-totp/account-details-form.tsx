"use client";

import { useActionState } from "react";
import { setAccountDetails, type AccountDetailsState } from "./actions";
import { PasswordInput } from "@/components/password-input";

const initialState: AccountDetailsState = {};

export function AccountDetailsForm({ token }: { token: string }) {
  const [state, formAction, pending] = useActionState(
    setAccountDetails,
    initialState,
  );

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <input type="hidden" name="token" value={token} />
      <label className="flex flex-col gap-1.5 text-sm font-medium">
        Your Name
        <input
          name="name"
          required
          autoFocus
          autoComplete="name"
          className="rounded-lg border border-neutral-300 dark:border-neutral-700 bg-[var(--background)] px-3 py-2.5 text-base font-normal focus:border-blue-900 focus:outline-none"
        />
      </label>

      <label className="flex flex-col gap-1.5 text-sm font-medium">
        Email
        <input
          name="email"
          type="email"
          required
          autoComplete="email"
          className="rounded-lg border border-neutral-300 dark:border-neutral-700 bg-[var(--background)] px-3 py-2.5 text-base font-normal focus:border-blue-900 focus:outline-none"
        />
      </label>

      <label className="flex flex-col gap-1.5 text-sm font-medium">
        Password
        <PasswordInput name="password" required autoComplete="new-password" />
        <span className="text-xs font-normal text-gray-500 dark:text-neutral-400">
          At least 12 characters.
        </span>
      </label>

      <label className="flex flex-col gap-1.5 text-sm font-medium">
        Confirm Password
        <PasswordInput name="confirmPassword" required autoComplete="new-password" />
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
        {pending ? "Saving…" : "Continue"}
      </button>
    </form>
  );
}

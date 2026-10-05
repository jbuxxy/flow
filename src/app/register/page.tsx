"use client";

import { useActionState } from "react";
import Image from "next/image";
import { GeometricBackground } from "@/components/geometric-background";
import { PasswordInput } from "@/components/password-input";
import { registerHousehold, type RegisterState } from "./actions";

const initialState: RegisterState = {};

export default function RegisterPage() {
  const [state, formAction, pending] = useActionState(
    registerHousehold,
    initialState,
  );

  return (
    <main className="relative mx-auto flex min-h-dvh max-w-sm flex-col justify-center gap-6 overflow-hidden px-4">
      <GeometricBackground />

      <div className="relative">
        <Image src="/icons/flow-mark.png" alt="" width={90} height={67} className="mb-3 h-14 w-auto" priority />
        <h1 className="text-3xl font-extrabold tracking-tight text-blue-900 dark:text-blue-300">
          Set Up <span className="dark:text-amber-400">flow</span>
        </h1>
        <p className="mt-1 text-sm text-gray-500 dark:text-neutral-400">
          Create your household and owner account. Two-factor setup comes
          right after this.
        </p>
      </div>

      <form action={formAction} className="relative flex flex-col gap-4">
        <Field label="Household Name" name="householdName" />
        <Field label="Your Name" name="name" autoComplete="name" />
        <Field label="Email" name="email" type="email" autoComplete="email" />
        <Field
          label="Password"
          name="password"
          type="password"
          autoComplete="new-password"
          hint="At least 12 characters."
        />

        {state.error && (
          <p className="text-sm text-red-600 dark:text-red-400" role="alert">
            {state.error}
          </p>
        )}

        <button
          type="submit"
          disabled={pending}
          className="mt-2 rounded-lg bg-blue-900 dark:bg-blue-700 px-4 py-2.5 font-medium text-white disabled:opacity-50"
        >
          {pending ? "Creating…" : "Create Household"}
        </button>
      </form>
    </main>
  );
}

function Field({
  label,
  name,
  type = "text",
  autoComplete,
  defaultValue,
  hint,
}: {
  label: string;
  name: string;
  type?: string;
  autoComplete?: string;
  defaultValue?: string;
  hint?: string;
}) {
  return (
    <label className="flex flex-col gap-1.5 text-sm font-medium">
      {label}
      {type === "password" ? (
        <PasswordInput
          name={name}
          required
          autoComplete={autoComplete}
          defaultValue={defaultValue}
        />
      ) : (
        <input
          name={name}
          type={type}
          required
          autoComplete={autoComplete}
          defaultValue={defaultValue}
          className="rounded-lg border border-neutral-300 dark:border-neutral-700 px-3 py-2.5 text-base font-normal focus:border-blue-900 focus:outline-none"
        />
      )}
      {hint && <span className="text-xs font-normal text-gray-500 dark:text-neutral-400">{hint}</span>}
    </label>
  );
}

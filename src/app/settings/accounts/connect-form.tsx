"use client";

import { useActionState } from "react";
import { connectSimpleFin, type ConnectState } from "./actions";

const initialState: ConnectState = {};

export function ConnectForm() {
  const [state, formAction, pending] = useActionState(connectSimpleFin, initialState);

  return (
    <form action={formAction} className="flex flex-col gap-3 rounded-xl border border-blue-100 dark:border-neutral-800 p-4">
      <h2 className="text-sm font-semibold text-emerald-700 dark:text-emerald-400">Connect SimpleFIN</h2>
      <p className="text-sm text-gray-600 dark:text-neutral-400">
        Sign up at{" "}
        <span className="font-medium text-neutral-900 dark:text-neutral-100">bridge.simplefin.org</span>{" "}
        ($1.50/mo), link your accounts there, then paste the one-time setup
        token it gives you below. It&apos;s claimed once and exchanged for a
        permanent connection — the token itself won&apos;t work a second time.
      </p>
      <textarea
        name="setupToken"
        placeholder="Paste your SimpleFIN setup token"
        required
        rows={3}
        className="rounded-lg border border-neutral-300 dark:border-neutral-700 px-3 py-2.5 text-sm focus:border-blue-900 focus:outline-none"
      />
      {state.error && (
        <p className="text-sm text-red-600 dark:text-red-400" role="alert">
          {state.error}
        </p>
      )}
      <button
        type="submit"
        disabled={pending}
        className="rounded-lg bg-blue-900 dark:bg-blue-700 px-4 py-2.5 text-sm font-medium text-white disabled:opacity-50"
      >
        {pending ? "Connecting…" : "Connect"}
      </button>
    </form>
  );
}

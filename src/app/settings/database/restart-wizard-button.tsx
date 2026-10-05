"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { restartOnboarding } from "./actions";

export function RestartWizardButton() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  return (
    <div className="rounded-2xl border border-blue-100 dark:border-neutral-800 p-4">
      <h2 className="text-sm font-semibold text-emerald-700 dark:text-emerald-400">Setup Wizard</h2>
      <p className="mt-1 text-xs text-gray-500 dark:text-neutral-400">
        Re-run the goal + starter-bucket setup you saw when this household was first created.
      </p>
      <button
        type="button"
        onClick={() => startTransition(async () => {
          await restartOnboarding();
          router.push("/onboarding");
        })}
        disabled={pending}
        className="mt-3 rounded-lg border border-neutral-300 dark:border-neutral-700 px-4 py-2.5 text-sm font-medium disabled:opacity-50"
      >
        {pending ? "Restarting…" : "Restart Setup Wizard"}
      </button>
    </div>
  );
}

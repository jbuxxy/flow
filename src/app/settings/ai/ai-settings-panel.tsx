"use client";

import { useActionState, useState, useTransition } from "react";
import { useActionToast } from "@/lib/use-action-toast";
import { showToast } from "@/lib/toast";
import { Pencil, RotateCw } from "lucide-react";
import { SelectField } from "@/components/select-field";
import { saveAiSettings, disconnectAiSettings, retestAiConnection, type AiSettingsState } from "./actions";
import { AiErrorNotice } from "./ai-error-notice";
import { ProviderIcon } from "./provider-icon";
import type { AiConnectionStatus, AiProvider } from "@prisma/client";

const PROVIDER_LABEL: Record<AiProvider, string> = {
  GEMINI: "Gemini",
  OPENAI: "OpenAI",
  ANTHROPIC: "Anthropic (Claude)",
  GROK: "Grok (xAI)",
};

const PROVIDER_OPTIONS = (Object.keys(PROVIDER_LABEL) as AiProvider[]).map((value) => ({
  value,
  label: PROVIDER_LABEL[value],
}));

const initialState: AiSettingsState = {};

function AiSettingsForm({
  currentProvider,
  onCancel,
  onSaved,
}: {
  currentProvider: AiProvider | null;
  onCancel?: () => void;
  onSaved?: () => void;
}) {
  const [state, formAction, pending] = useActionState(saveAiSettings, initialState);
  const [provider, setProvider] = useState<string>(currentProvider ?? "GEMINI");

  // useActionState's `state` stays referentially the same shape across a
  // successful submit (still just `{}`), so success is only observable as
  // a pending->not-pending transition with no error — useActionToast fires the
  // confirmation toast and calls onSaved on that edge.
  useActionToast(pending, state, { success: "AI Settings Saved", onSuccess: () => onSaved?.() });

  return (
    <form action={formAction} className="flex flex-col gap-3 rounded-xl border border-blue-100 dark:border-neutral-800 p-4">
      <div>
        <label className="mb-1 block text-xs text-gray-500 dark:text-neutral-400">Provider</label>
        <SelectField name="provider" value={provider} onChange={setProvider} options={PROVIDER_OPTIONS} searchable={false} large />
      </div>
      <div>
        <label className="mb-1 block text-xs text-gray-500 dark:text-neutral-400">API Key</label>
        <input
          name="apiKey"
          type="password"
          autoComplete="off"
          placeholder="Paste your API key"
          required
          className="w-full rounded-lg border border-neutral-300 dark:border-neutral-700 px-3 py-2.5 text-sm focus:border-blue-900 focus:outline-none"
        />
      </div>
      {state.error && (
        <p className="text-sm text-red-600 dark:text-red-400" role="alert">
          {state.error}
        </p>
      )}
      <div className="flex items-center justify-end gap-3">
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            className="rounded-lg border border-neutral-300 dark:border-neutral-700 px-4 py-2.5 text-sm font-medium"
          >
            Cancel
          </button>
        )}
        <button
          type="submit"
          disabled={pending}
          className="rounded-lg bg-blue-900 dark:bg-blue-700 px-4 py-2.5 text-sm font-medium text-white disabled:opacity-50"
        >
          {pending ? "Saving…" : "Save"}
        </button>
      </div>
    </form>
  );
}

export function AiSettingsPanel({
  existing,
}: {
  existing: { provider: AiProvider; status: AiConnectionStatus; lastError: string | null } | null;
}) {
  const [replacing, setReplacing] = useState(false);
  const [disconnectPending, startDisconnect] = useTransition();
  const [retestPending, startRetest] = useTransition();

  if (!existing) return <AiSettingsForm currentProvider={null} />;

  if (replacing) {
    return (
      <AiSettingsForm
        currentProvider={existing.provider}
        onCancel={() => setReplacing(false)}
        onSaved={() => setReplacing(false)}
      />
    );
  }

  return (
    <div className="rounded-xl border border-blue-100 dark:border-neutral-800 p-4">
      {/* Same title+status-dot-on-the-left, actions-right-aligned layout as
          the SimpleFIN Status card (settings/accounts/page.tsx) — an `h3`
          so it picks up Comfortaa from the global h1-h6 rule, same as every
          other card title in the app. */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <h3 className="text-base font-semibold text-emerald-700 dark:text-emerald-400">AI Status</h3>
          {existing.status === "ACTIVE" ? (
            <span
              role="img"
              aria-label="Connected"
              title="Connected"
              className="h-2 w-2 rounded-full bg-emerald-500 shadow-[0_0_6px_var(--color-emerald-500)]"
            />
          ) : (
            <span
              role="img"
              aria-label="Error"
              title="Error"
              className="h-2 w-2 rounded-full bg-red-500 shadow-[0_0_6px_var(--color-red-500)]"
            />
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {existing.status === "ERROR" && (
            // Re-runs the same real test call saveAiSettings does at save
            // time, against the already-stored key (retestAiConnection,
            // ./actions.ts) — clears a transient failure (a provider outage,
            // a since-lifted rate limit) without waiting for the next real
            // AI feature call to happen to retry it on its own.
            <button
              onClick={() =>
                startRetest(async () => {
                  try {
                    await retestAiConnection();
                    showToast("Connection Retested");
                  } catch {
                    showToast("Retest Failed", "error");
                  }
                })
              }
              disabled={retestPending}
              aria-label="Retest Connection"
              title="Retest Connection"
              className="rounded-lg border border-neutral-300 dark:border-neutral-700 p-2 text-neutral-500 dark:text-neutral-400 disabled:opacity-50"
            >
              <RotateCw size={15} className={retestPending ? "animate-spin" : undefined} />
            </button>
          )}
          <button
            onClick={() => setReplacing(true)}
            aria-label="Replace Key"
            title="Replace Key"
            className="rounded-lg border border-neutral-300 dark:border-neutral-700 p-2 text-neutral-500 dark:text-neutral-400"
          >
            <Pencil size={15} />
          </button>
          {/* Text, not icon-only — destructive settings actions keep a
              label (see WORKING_ON.md's UI conventions), same as
              ConnectionActions' own Disconnect button. */}
          <button
            onClick={() => {
              if (
                !confirm(
                  "Disconnect your AI provider? AI features (categorization suggestions, monthly feedback, asset estimates, bill summaries) will stop working for this household until reconfigured.",
                )
              )
                return;
              startDisconnect(async () => {
                try {
                  await disconnectAiSettings();
                  showToast("AI Provider Disconnected");
                } catch {
                  showToast("Something Went Wrong", "error");
                }
              });
            }}
            disabled={disconnectPending}
            className="rounded-lg border border-neutral-300 dark:border-neutral-700 px-2.5 py-2 text-sm font-medium text-red-600 dark:text-red-400 disabled:opacity-50"
          >
            {disconnectPending ? "Disconnecting…" : "Disconnect"}
          </button>
        </div>
      </div>
      <p className="mt-1.5 flex items-center gap-1.5 text-sm text-neutral-900 dark:text-neutral-100">
        Provider:
        <ProviderIcon provider={existing.provider} />
        <span className="font-medium">{PROVIDER_LABEL[existing.provider]}</span>
      </p>
      <p className="mt-1 text-sm tracking-widest text-gray-500 dark:text-neutral-400">••••••••••••</p>
      {existing.status === "ERROR" && existing.lastError && (
        <AiErrorNotice provider={existing.provider} raw={existing.lastError} />
      )}
    </div>
  );
}

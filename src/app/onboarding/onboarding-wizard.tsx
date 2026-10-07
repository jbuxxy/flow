"use client";

import { useState, useTransition, useActionState } from "react";
import { useRouter } from "next/navigation";
import { Sparkles, Plus, Trash2, CheckCircle2, AlertTriangle, Mail } from "lucide-react";
import { SelectField } from "@/components/select-field";
import { showToast } from "@/lib/toast";
import { Switch } from "@/components/switch";
import { GOAL_POSTURE_OPTIONS } from "@/lib/goal-posture";
import { ConnectForm } from "@/app/settings/accounts/connect-form";
import { AiSettingsPanel } from "@/app/settings/ai/ai-settings-panel";
import { EmailConnectForm } from "@/app/settings/email/email-settings-panel";
import {
  saveProfileAndAdvance,
  advanceOnboardingStep,
  confirmBucketsAndFinish,
  type SaveProfileState,
} from "./actions";
import type {
  OnboardingStep,
  HouseholdGoalPosture,
  IncomeCalcMethod,
  AiProvider,
  AiConnectionStatus,
  EmailConnectionStatus,
} from "@prisma/client";
import type { ReportFindings } from "@/lib/ai";

type TrackingMode = "SPEND" | "RECURRING" | "MIXED";
type BucketDraft = { name: string; monthlyCapCents: number; trackingMode: TrackingMode; rationale?: string };

const initialProfileState: SaveProfileState = {};

export function OnboardingWizard({
  step,
  profile,
  bankConnected,
  bankSyncError,
  aiExisting,
  emailConnection,
  bucketCount,
  startupReport,
}: {
  step: OnboardingStep;
  profile: {
    goalPosture: HouseholdGoalPosture;
    adultsCount: number;
    kidsCount: number;
    incomeCalcMethod: IncomeCalcMethod;
    includeP2PInIncomeCalc: boolean;
  };
  bankConnected: boolean;
  bankSyncError: string | null;
  aiExisting: { provider: AiProvider; status: AiConnectionStatus; lastError: string | null } | null;
  emailConnection: { imapUser: string; status: EmailConnectionStatus } | null;
  bucketCount: number;
  startupReport: { narrative: string; findings: ReportFindings } | null;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function goTo(next: OnboardingStep) {
    startTransition(async () => {
      await advanceOnboardingStep(next);
      router.refresh();
    });
  }

  if (step === "CONNECT") {
    return (
      <ConnectPhase
        bankConnected={bankConnected}
        bankSyncError={bankSyncError}
        aiExisting={aiExisting}
        emailConnection={emailConnection}
        onEmailSaved={() => router.refresh()}
        onContinue={() => goTo("REPORT")}
        pending={pending}
      />
    );
  }
  if (step === "REPORT") {
    return <ReportPhase startupReport={startupReport} onContinue={() => goTo("BUCKETS")} pending={pending} />;
  }
  if (step === "BUCKETS") {
    return (
      <BucketsPhase
        suggestions={startupReport?.findings.newBucketSuggestions ?? null}
        bucketCount={bucketCount}
        onDone={() => router.push("/")}
      />
    );
  }

  return <ProfilePhase profile={profile} />;
}

function ProfilePhase({
  profile,
}: {
  profile: {
    goalPosture: HouseholdGoalPosture;
    adultsCount: number;
    kidsCount: number;
    incomeCalcMethod: IncomeCalcMethod;
    includeP2PInIncomeCalc: boolean;
  };
}) {
  const [state, formAction, pending] = useActionState(saveProfileAndAdvance, initialProfileState);
  const [goalPosture, setGoalPosture] = useState<HouseholdGoalPosture>(profile.goalPosture);
  const [incomeCalcMethod, setIncomeCalcMethod] = useState<IncomeCalcMethod>(profile.incomeCalcMethod);
  const [includeP2P, setIncludeP2P] = useState(profile.includeP2PInIncomeCalc);

  return (
    <div className="flex flex-col gap-4">
      <form action={formAction} className="flex flex-col gap-4">
        <label className="flex flex-col gap-1.5 text-sm font-medium">
          What&apos;s your main goal right now?
          <SelectField
            name="goalPosture"
            value={goalPosture}
            onChange={(v) => setGoalPosture(v as HouseholdGoalPosture)}
            searchable={false}
            options={GOAL_POSTURE_OPTIONS}
          />
        </label>
        <div className="flex gap-3">
          <label className="flex flex-1 flex-col gap-1.5 text-sm font-medium">
            Adults
            <input
              name="adultsCount"
              type="number"
              min={1}
              max={10}
              defaultValue={profile.adultsCount}
              required
              className="rounded-lg border border-neutral-300 dark:border-neutral-700 px-3 py-2.5 text-base font-normal focus:border-blue-900 focus:outline-none"
            />
          </label>
          <label className="flex flex-1 flex-col gap-1.5 text-sm font-medium">
            Kids
            <input
              name="kidsCount"
              type="number"
              min={0}
              max={10}
              defaultValue={profile.kidsCount}
              required
              className="rounded-lg border border-neutral-300 dark:border-neutral-700 px-3 py-2.5 text-base font-normal focus:border-blue-900 focus:outline-none"
            />
          </label>
        </div>
        <p className="text-xs text-gray-500 dark:text-neutral-400">
          Used to size realistic starter budgets before there&apos;s much spending history. You can change this any
          time in Settings.
        </p>
        <label className="flex flex-col gap-1.5 text-sm font-medium">
          Monthly Income Calculation
          <SelectField
            name="incomeCalcMethod"
            value={incomeCalcMethod}
            onChange={(v) => setIncomeCalcMethod(v as IncomeCalcMethod)}
            searchable={false}
            options={[
              { value: "MONTHLY_AVERAGE", label: "Monthly Average (Includes 3rd Paycheck Months)" },
              { value: "BIWEEKLY_CONSERVATIVE", label: "Biweekly × 2 (Ignores 3rd Paycheck Months)" },
            ]}
          />
        </label>
        <label className="flex items-center justify-between gap-3 text-sm font-medium">
          <span>
            Include P2P Income
            <span className="block text-xs font-normal text-gray-500 dark:text-neutral-400">
              Counts this month&apos;s P2P credits toward the total
            </span>
          </span>
          <Switch checked={includeP2P} ariaLabel="Include P2P Income" onChange={() => setIncludeP2P((v) => !v)} />
          <input type="hidden" name="includeP2P" value={includeP2P ? "on" : ""} />
        </label>
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
          {pending ? "Saving…" : "Continue"}
        </button>
      </form>
    </div>
  );
}

function ConnectPhase({
  bankConnected,
  bankSyncError,
  aiExisting,
  emailConnection,
  onEmailSaved,
  onContinue,
  pending,
}: {
  bankConnected: boolean;
  bankSyncError: string | null;
  aiExisting: { provider: AiProvider; status: AiConnectionStatus; lastError: string | null } | null;
  emailConnection: { imapUser: string; status: EmailConnectionStatus } | null;
  onEmailSaved: () => void;
  onContinue: () => void;
  pending: boolean;
}) {
  const aiConnected = aiExisting?.status === "ACTIVE";
  const canContinue = bankConnected && aiConnected;
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-gray-500 dark:text-neutral-400">
        Both are required — flow is built entirely around real transaction sync and AI-assisted budgeting, not
        manual entry.
      </p>
      <div>
        <h2 className="mb-2 text-sm font-semibold text-emerald-700 dark:text-emerald-400">Connect Your Bank</h2>
        <p className="mb-2 text-xs text-gray-500 dark:text-neutral-400">
          Credit cards and loans sync automatically — we&apos;ll ask you to confirm each one&apos;s rate and due date
          once you&apos;re in.
        </p>
        {bankConnected ? (
          bankSyncError ? (
            <div className="flex flex-col gap-2 rounded-xl border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/30 px-4 py-3 text-sm text-amber-800 dark:text-amber-300">
              <p className="flex items-center gap-1.5">
                <AlertTriangle size={16} className="shrink-0 text-amber-600 dark:text-amber-400" />
                Connected, but the first sync had a problem
              </p>
              <p className="text-xs text-amber-700 dark:text-amber-400">{bankSyncError}</p>
              <a href="/settings/accounts" className="text-xs font-medium underline">
                Fix Connection or Retry Sync
              </a>
            </div>
          ) : (
            <p className="flex items-center gap-1.5 rounded-xl border border-emerald-300 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-950/30 px-4 py-3 text-sm text-emerald-800 dark:text-emerald-300">
              <CheckCircle2 size={16} className="shrink-0 text-emerald-600 dark:text-emerald-400" />
              SimpleFIN Connected
            </p>
          )
        ) : (
          <ConnectForm />
        )}
      </div>
      <div>
        <h2 className="mb-2 text-sm font-semibold text-emerald-700 dark:text-emerald-400">Connect AI</h2>
        <p className="mb-2 text-xs text-gray-500 dark:text-neutral-400">
          Powers the analysis below and ongoing budget coaching. Bring your own API key (Gemini, OpenAI, Anthropic,
          or Grok).
        </p>
        <AiSettingsPanel existing={aiExisting} />
      </div>
      <div>
        <h2 className="mb-2 text-sm font-semibold text-emerald-700 dark:text-emerald-400">
          Connect Your Inbox <span className="font-normal text-gray-500 dark:text-neutral-400">— Optional</span>
        </h2>
        <p className="mb-2 text-xs text-gray-500 dark:text-neutral-400">
          Lets Flow read receipts and payment notifications from your email to add item detail, verify charge
          amounts, and name the real business behind Venmo and Amazon charges. You can skip this and set it up
          later in Settings.
        </p>
        {emailConnection ? (
          <p className="flex items-center gap-1.5 rounded-xl border border-emerald-300 bg-emerald-50 px-4 py-3 text-sm text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-300">
            <Mail size={16} className="shrink-0 text-emerald-600 dark:text-emerald-400" />
            Inbox Connected — {emailConnection.imapUser}
          </p>
        ) : (
          <EmailConnectForm onSaved={onEmailSaved} hideHeading />
        )}
      </div>
      <button
        type="button"
        onClick={onContinue}
        disabled={pending || !canContinue}
        className="rounded-lg bg-blue-900 dark:bg-blue-700 px-4 py-2.5 text-sm font-medium text-white disabled:opacity-50"
      >
        {pending ? "Continuing…" : "Continue"}
      </button>
    </div>
  );
}

function ReportPhase({
  startupReport,
  onContinue,
  pending,
}: {
  startupReport: { narrative: string; findings: ReportFindings } | null;
  onContinue: () => void;
  pending: boolean;
}) {
  return (
    <div className="flex flex-col gap-4">
      {startupReport ? (
        <div className="rounded-2xl border border-emerald-300 dark:border-emerald-800 bg-gradient-to-br from-emerald-50 to-blue-50 dark:from-emerald-950/40 dark:to-blue-950/30 p-4">
          <div className="mb-2 flex items-center gap-2">
            <Sparkles size={16} className="text-emerald-600 dark:text-emerald-400" />
            <h2 className="text-sm font-semibold text-emerald-800 dark:text-emerald-300">Here&apos;s What We Found</h2>
          </div>
          <p className="whitespace-pre-line text-sm leading-relaxed text-neutral-800 dark:text-neutral-200">
            {startupReport.narrative}
          </p>
        </div>
      ) : (
        <p className="text-sm text-gray-500 dark:text-neutral-400">
          Still gathering enough transaction history to analyze — you can continue and check back on Reports later.
        </p>
      )}
      <button
        type="button"
        onClick={onContinue}
        disabled={pending}
        className="rounded-lg bg-blue-900 dark:bg-blue-700 px-4 py-2.5 text-sm font-medium text-white disabled:opacity-50"
      >
        {pending ? "Continuing…" : "Review Buckets"}
      </button>
    </div>
  );
}

function BucketsPhase({
  suggestions,
  bucketCount,
  onDone,
}: {
  suggestions: ReportFindings["newBucketSuggestions"] | null;
  bucketCount: number;
  onDone: () => void;
}) {
  const [drafts, setDrafts] = useState<BucketDraft[]>(() =>
    (suggestions ?? []).map((b) => ({
      name: b.name,
      monthlyCapCents: b.monthlyCapCents,
      trackingMode: b.trackingMode,
      rationale: b.rationale,
    })),
  );
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  // Re-entry: this household already finished the buckets phase once (e.g.
  // the wizard was restarted after already having buckets) — nothing left
  // to confirm, never re-create/duplicate a starter set on top of theirs.
  // Still routes through confirmBucketsAndFinish (with an empty array, a
  // no-op there since existingCount > 0) rather than navigating home
  // directly — that's the only place onboardingCompletedAt gets set, so
  // skipping it here used to strand a restarted household in a redirect
  // loop back to /onboarding.
  if (bucketCount > 0) {
    return (
      <div className="flex flex-col gap-4">
        <p className="text-sm text-gray-500 dark:text-neutral-400">
          You already have buckets set up — nothing more to do here.
        </p>
        {error && (
          <p className="text-sm text-red-600 dark:text-red-400" role="alert">
            {error}
          </p>
        )}
        <button
          type="button"
          onClick={() => {
            setError(null);
            startTransition(async () => {
              const result = await confirmBucketsAndFinish([]);
              if (result.error) setError(result.error);
              else { showToast("Setup Complete"); onDone(); }
            });
          }}
          disabled={pending}
          className="rounded-lg bg-blue-900 dark:bg-blue-700 px-4 py-2.5 text-sm font-medium text-white disabled:opacity-50"
        >
          {pending ? "Finishing…" : "Finish"}
        </button>
      </div>
    );
  }

  function updateDraft(i: number, patch: Partial<BucketDraft>) {
    setDrafts((prev) => prev.map((d, idx) => (idx === i ? { ...d, ...patch } : d)));
  }

  function removeDraft(i: number) {
    setDrafts((prev) => prev.filter((_, idx) => idx !== i));
  }

  function addDraft() {
    setDrafts((prev) => [...prev, { name: "", monthlyCapCents: 0, trackingMode: "SPEND" }]);
  }

  function confirm() {
    setError(null);
    startTransition(async () => {
      const result = await confirmBucketsAndFinish(
        drafts.map(({ name, monthlyCapCents, trackingMode }) => ({ name, monthlyCapCents, trackingMode })),
      );
      if (result.error) setError(result.error);
      else { showToast("Setup Complete"); onDone(); }
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h2 className="text-sm font-semibold text-emerald-700 dark:text-emerald-400">Suggested Buckets</h2>
        <p className="mt-1 text-xs text-gray-500 dark:text-neutral-400">
          Bills and subscriptions are tracked as <span className="font-medium">Recurring</span> — they never
          auto-file as everyday spend, only ever show up once you confirm a specific bill. Edit, remove, or add
          anything before confirming.
          {drafts.length === 0 && " Nothing suggested yet — add your own below."}
        </p>
      </div>

      <ul className="flex flex-col gap-3">
        {drafts.map((d, i) => (
          <li key={i} className="rounded-xl border border-blue-100 dark:border-neutral-800 p-3">
            <div className="flex items-center gap-2">
              <input
                value={d.name}
                onChange={(e) => updateDraft(i, { name: e.target.value })}
                placeholder="Bucket name"
                className="min-w-0 flex-1 rounded-lg border border-neutral-300 dark:border-neutral-700 px-3 py-2 text-sm focus:border-blue-900 focus:outline-none"
              />
              <div className="flex items-center gap-1 text-sm">
                <span className="text-gray-500 dark:text-neutral-400">$</span>
                <input
                  type="number"
                  min={0}
                  value={Math.round(d.monthlyCapCents / 100)}
                  onChange={(e) => updateDraft(i, { monthlyCapCents: Math.round(Number(e.target.value) * 100) })}
                  className="w-20 rounded-lg border border-neutral-300 dark:border-neutral-700 px-2 py-2 text-sm focus:border-blue-900 focus:outline-none"
                />
                <span className="text-xs text-gray-500 dark:text-neutral-400">/mo</span>
              </div>
              <button
                type="button"
                onClick={() => removeDraft(i)}
                aria-label="Remove Bucket"
                title="Remove Bucket"
                className="shrink-0 text-red-600 dark:text-red-400"
              >
                <Trash2 size={16} />
              </button>
            </div>
            <div className="mt-2">
              <SelectField
                value={d.trackingMode}
                onChange={(v) => updateDraft(i, { trackingMode: v as TrackingMode })}
                searchable={false}
                options={[
                  { value: "SPEND", label: "Singles" },
                  { value: "RECURRING", label: "Recurring" },
                  { value: "MIXED", label: "Mixed" },
                ]}
              />
            </div>
            {d.rationale && <p className="mt-1 text-xs text-gray-500 dark:text-neutral-400">{d.rationale}</p>}
          </li>
        ))}
      </ul>

      <button
        type="button"
        onClick={addDraft}
        className="flex items-center justify-center gap-1.5 rounded-lg border border-neutral-200 dark:border-neutral-800 px-4 py-2.5 text-sm font-medium text-blue-800 dark:text-blue-400"
      >
        <Plus size={16} /> Add Bucket
      </button>

      {error && (
        <p className="text-sm text-red-600 dark:text-red-400" role="alert">
          {error}
        </p>
      )}

      <button
        type="button"
        onClick={confirm}
        disabled={pending || drafts.length === 0}
        className="rounded-lg bg-blue-900 dark:bg-blue-700 px-4 py-2.5 text-sm font-medium text-white disabled:opacity-50"
      >
        {pending ? "Setting up…" : "Confirm & Finish"}
      </button>
    </div>
  );
}

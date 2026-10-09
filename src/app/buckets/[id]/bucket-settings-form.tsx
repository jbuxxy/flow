"use client";

import { useActionState, useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, ChevronDown, Pencil, Trash2 } from "lucide-react";
import { useStoredBoolean } from "@/lib/use-stored-boolean";
import {
  updateBucketSettings,
  deleteBucket,
  type UpdateBucketState,
  type BucketAlertOverrideChoice,
  type BucketAlertOverrideType,
} from "./actions";
import { removeAmountRoutingRule, updateAmountRoutingRule } from "@/app/buckets/actions";
import { MoneyInput } from "@/components/money-input";
import { SelectField } from "@/components/select-field";
import { CategoryManager } from "./category-manager";
import { RoutingRuleComposer } from "@/components/routing-rule-composer";
import { BucketAlertRecipients, type AlertMember } from "./bucket-alert-recipients";
import { LockableSwitch } from "@/components/lockable-switch";
import { formatCents } from "@/lib/money";
import { useActionToast } from "@/lib/use-action-toast";
import { showToast } from "@/lib/toast";
import { BUCKET_TYPE_DESCRIPTION, BUCKET_TYPE_OPTIONS, type BucketType } from "@/app/buckets/bucket-type";
import type { CategoryOption } from "@/app/bills/category-picker";
import type { AmountRoutingRule } from "./bucket-title-settings";

const initialState: UpdateBucketState = {};

type TrackingMode = "SPEND" | "RECURRING" | "MIXED";

// userId -> alert type -> the lock an owner has placed on that user for that
// type on this bucket. Absent = "Default" (follows that member's own global
// NotificationPreference) — see BucketAlertOverride's own schema comment.
export type BucketAlertOverridesByUser = Record<string, Partial<Record<BucketAlertOverrideType, "ALWAYS" | "NEVER">>>;

export function BucketSettingsForm({
  bucket,
  categories,
  amountRoutingRules,
  routingBuckets,
  // Name/type/cap/threshold are owner-only (household request, 2026-09-12)
  // — a non-owner sees their current values as plain text instead of an
  // editable control, same "View Only" idea member-notification-prefs.tsx
  // uses for a preference grid someone can't touch. Alerts checkboxes stay
  // open to every member (they're a bucket-wide kill switch, not a personal
  // preference), and AI Assist too; the real boundary is server-side either
  // way (updateBucketSettings silently keeps the bucket's existing values
  // for the four owner-only fields when the submitter isn't OWNER,
  // regardless of what a tampered request might carry).
  isOwner,
  alertsLocked,
  currentUserId,
  members,
  alertOverrides,
  onSaved,
}: {
  bucket: {
    id: string;
    name: string;
    monthlyCapCents: number;
    warningThresholdPct: number;
    paceAlertEnabled: boolean;
    weeklyReportEnabled: boolean;
    transactionAlertEnabled: boolean;
    trackingMode: TrackingMode;
    excludedFromAllocation: boolean;
    aiInstructions: string | null;
  };
  categories: CategoryOption[];
  amountRoutingRules: AmountRoutingRule[];
  // Non-recurring buckets a routing rule can point at — the destination
  // options when editing a rule's target. Includes this bucket.
  routingBuckets: { id: string; name: string }[];
  isOwner: boolean;
  // An owner locked this member's notifications (User.notificationsLocked) —
  // the bucket's alert checkboxes are read-only for them (the server keeps
  // the existing values regardless, updateBucketSettings).
  alertsLocked: boolean;
  currentUserId: string;
  // Every household member — for the owner-only "Notify" recipient picker.
  members: AlertMember[];
  alertOverrides: BucketAlertOverridesByUser;
  onSaved?: () => void;
}) {
  const [state, formAction, pending] = useActionState(updateBucketSettings, initialState);
  useActionToast(pending, state, { success: "Bucket Saved" });
  // "One-Time Purchase" is a 4th option in the type dropdown (see bucket-type.ts)
  // rather than its own checkbox — on submit it maps back to trackingMode SPEND
  // + excludedFromAllocation.
  const [bucketType, setBucketType] = useState<BucketType>(
    bucket.excludedFromAllocation ? "ONE_TIME" : bucket.trackingMode,
  );
  const oneTime = bucketType === "ONE_TIME";
  const [deletePending, startDeleteTransition] = useTransition();
  const router = useRouter();
  const isFirstRender = useRef(true);
  // Modal (src/components/modal.tsx) keeps this form mounted at all times —
  // only the native <dialog>'s own visibility toggles — so `onSaved` is a
  // fresh closure every time the parent re-renders for any reason, most
  // notably the very click that opens the modal (BucketTitleSettings'
  // `onClick={() => setOpen(true)}`). A ref sidesteps that: the effect below
  // only needs the *latest* onSaved when it actually fires, not a reason to
  // fire in the first place — depending on onSaved directly (real bug,
  // 2026-08-19) made that opening re-render itself count as "state changed,
  // no error," closing the modal on the same click that opened it.
  const onSavedRef = useRef(onSaved);
  useEffect(() => {
    onSavedRef.current = onSaved;
  }, [onSaved]);

  // useActionState's returned state has the same `{}` shape on both the
  // initial render and a successful save, so a save is detected by "state
  // changed after the first render, with no error" rather than by shape.
  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }
    if (!state.error) onSavedRef.current?.();
  }, [state]);

  const inputClass =
    "rounded-lg border border-neutral-300 dark:border-neutral-700 px-3 py-2.5 text-base font-normal focus:border-blue-900 focus:outline-none";
  const checkboxClass = "mt-0.5 h-4 w-4 shrink-0 accent-blue-900 dark:accent-blue-700";
  const showRouting = bucketType === "SPEND" || bucketType === "MIXED";
  // Categories + Amount Routing sit outside the <form> (their own actions,
  // auto-saved) — Save Settings is placed past them at the bottom via
  // `form=` so it reads as the last thing in the panel (household request).
  const formId = `bucket-settings-${bucket.id}`;

  return (
    <div className="flex flex-col gap-4">
      <form id={formId} action={formAction} className="flex flex-col gap-3">
        <input type="hidden" name="bucketId" value={bucket.id} />
        {/* One-Time Purchase submits as trackingMode SPEND + the exclusion
            flag; the real modes submit themselves. */}
        <input type="hidden" name="trackingMode" value={oneTime ? "SPEND" : bucketType} />
        {oneTime && <input type="hidden" name="excludedFromAllocation" value="on" />}

        {isOwner ? (
          <label className="flex flex-col gap-1.5 text-sm font-medium">
            Name
            <input name="name" defaultValue={bucket.name} required className={inputClass} />
          </label>
        ) : (
          <ReadOnlyField label="Name" value={bucket.name} hiddenName="name" />
        )}

        {isOwner ? (
          <label className="flex flex-col gap-1.5 text-sm font-medium">
            What This Bucket Tracks
            <SelectField
              value={bucketType}
              onChange={(v) => setBucketType(v as BucketType)}
              searchable={false}
              options={BUCKET_TYPE_OPTIONS}
            />
            <span className="text-xs font-normal text-gray-500 dark:text-neutral-400">
              {BUCKET_TYPE_DESCRIPTION[bucketType]}
            </span>
          </label>
        ) : (
          <ReadOnlyField
            label="What This Bucket Tracks"
            value={BUCKET_TYPE_OPTIONS.find((o) => o.value === bucketType)?.label ?? bucketType}
          />
        )}

        {oneTime ? (
          <>
            {isOwner ? (
              <label className="flex flex-col gap-1.5 text-sm font-medium">
                Amount
                <MoneyInput name="monthlyCap" defaultCents={bucket.monthlyCapCents} required className={inputClass} />
              </label>
            ) : (
              <ReadOnlyField
                label="Amount"
                value={formatCents(bucket.monthlyCapCents)}
                hiddenName="monthlyCap"
                hiddenValue={(bucket.monthlyCapCents / 100).toFixed(2)}
              />
            )}
            {/* Non-applicable fields ride along unchanged. */}
            <input type="hidden" name="warningThresholdPct" value={bucket.warningThresholdPct} />
            <input type="hidden" name="aiInstructions" value={bucket.aiInstructions ?? ""} />
            <label className="flex items-start gap-2 text-sm font-normal">
              <input
                type="checkbox"
                name="transactionAlertEnabled"
                defaultChecked={bucket.transactionAlertEnabled}
                disabled={alertsLocked}
                className={checkboxClass}
              />
              Notify Me When This Payment Is Made
            </label>
            {isOwner ? (
              <BucketAlertRecipients
                bucketId={bucket.id}
                type="BUCKET_TRANSACTION"
                members={members}
                overrides={overridesForType(alertOverrides, "BUCKET_TRANSACTION")}
              />
            ) : (
              <LockedAlertNote lock={alertOverrides[currentUserId]?.BUCKET_TRANSACTION} />
            )}
          </>
        ) : (
          <div className="grid grid-cols-2 gap-3">
            {isOwner ? (
              <label className="flex flex-col gap-1.5 text-sm font-medium">
                Monthly Cap
                <MoneyInput name="monthlyCap" defaultCents={bucket.monthlyCapCents} required className={inputClass} />
              </label>
            ) : (
              <ReadOnlyField
                label="Monthly Cap"
                value={formatCents(bucket.monthlyCapCents)}
                hiddenName="monthlyCap"
                hiddenValue={(bucket.monthlyCapCents / 100).toFixed(2)}
              />
            )}
            {isOwner ? (
              <label className="flex flex-col gap-1.5 text-sm font-medium">
                Warning Threshold (%)
                <input
                  name="warningThresholdPct"
                  type="number"
                  min={1}
                  max={100}
                  defaultValue={bucket.warningThresholdPct}
                  required
                  className={inputClass}
                />
              </label>
            ) : (
              <ReadOnlyField
                label="Warning Threshold (%)"
                value={String(bucket.warningThresholdPct)}
                hiddenName="warningThresholdPct"
              />
            )}
          </div>
        )}

        {!oneTime && (
          <CollapsibleSection storageKey="flow:bucket-settings:ai-assist-expanded" title="AI Assist (Optional)">
            <textarea
              name="aiInstructions"
              defaultValue={bucket.aiInstructions ?? ""}
              rows={2}
              maxLength={500}
              placeholder={'e.g. "Kids’ activities only — dance, soccer, swim lessons. Not toys, clothes, or birthday gifts."'}
              className="rounded-lg border border-neutral-300 dark:border-neutral-700 px-3 py-2.5 text-sm font-normal focus:border-blue-900 focus:outline-none"
            />
            <span className="text-xs font-normal text-gray-500 dark:text-neutral-400">
              A plain-language rule for what belongs in this bucket — the AI reads it when deciding
              whether a new transaction fits, for edge cases the name and categories don&apos;t capture.
              Name merchants to include or exclude when you can.
            </span>
          </CollapsibleSection>
        )}
      </form>

      {!oneTime && (
        <div className="border-t border-neutral-100 dark:border-neutral-800 pt-4">
          <CategoryManager bucketId={bucket.id} categories={categories} />
        </div>
      )}

      {!oneTime && (
        <div className="border-t border-neutral-100 dark:border-neutral-800 pt-4">
          <CollapsibleSection storageKey="flow:bucket-settings:alerts-expanded" title="Alerts">
            <label className="flex items-start gap-2 text-sm font-normal">
              <input
                form={formId}
                type="checkbox"
                name="paceAlertEnabled"
                defaultChecked={bucket.paceAlertEnabled}
                disabled={alertsLocked}
                className={checkboxClass}
              />
              Alert me if spending is outpacing the month
            </label>
            {isOwner ? (
              <BucketAlertRecipients
                bucketId={bucket.id}
                type="BUCKET_PACE"
                members={members}
                overrides={overridesForType(alertOverrides, "BUCKET_PACE")}
              />
            ) : (
              <LockedAlertNote lock={alertOverrides[currentUserId]?.BUCKET_PACE} />
            )}

            <label className="flex items-start gap-2 text-sm font-normal">
              <input
                form={formId}
                type="checkbox"
                name="weeklyReportEnabled"
                defaultChecked={bucket.weeklyReportEnabled}
                disabled={alertsLocked}
                className={checkboxClass}
              />
              Send a weekly spending digest for this bucket
            </label>
            {isOwner ? (
              <BucketAlertRecipients
                bucketId={bucket.id}
                type="WEEKLY_BUCKET_REPORT"
                members={members}
                overrides={overridesForType(alertOverrides, "WEEKLY_BUCKET_REPORT")}
              />
            ) : (
              <LockedAlertNote lock={alertOverrides[currentUserId]?.WEEKLY_BUCKET_REPORT} />
            )}

            <label className="flex items-start gap-2 text-sm font-normal">
              <input
                form={formId}
                type="checkbox"
                name="transactionAlertEnabled"
                defaultChecked={bucket.transactionAlertEnabled}
                disabled={alertsLocked}
                className={checkboxClass}
              />
              Notify on every transaction, with the running total vs. cap
            </label>
            {isOwner ? (
              <BucketAlertRecipients
                bucketId={bucket.id}
                type="BUCKET_TRANSACTION"
                members={members}
                overrides={overridesForType(alertOverrides, "BUCKET_TRANSACTION")}
              />
            ) : (
              <LockedAlertNote lock={alertOverrides[currentUserId]?.BUCKET_TRANSACTION} />
            )}
          </CollapsibleSection>
        </div>
      )}

      {showRouting && (
        <div className="border-t border-neutral-100 dark:border-neutral-800 pt-4">
          <CollapsibleSection storageKey="flow:bucket-settings:amount-routing-expanded" title="Amount Routing">
            <p className="text-xs font-normal text-gray-500 dark:text-neutral-400">
              Send a merchant&apos;s small charges to a different bucket than its usual one — handy when a
              gas station doubles as a snack run.
            </p>
            {amountRoutingRules.length > 0 && (
              <AmountRoutingList bucketId={bucket.id} rules={amountRoutingRules} buckets={routingBuckets} />
            )}
            <RoutingRuleComposer fromBucketId={bucket.id} />
          </CollapsibleSection>
        </div>
      )}

      {state.error && (
        <p className="text-sm text-red-600 dark:text-red-400" role="alert">
          {state.error}
        </p>
      )}

      {/* Delete (left) and Save Settings (right) share the last row —
          opposite corners + different weight (red outline vs. blue check) so
          a tap meant for one can't land on the other (household report:
          Delete stacked right under Save was a misclick trap). Save Settings
          submits the form above by id — it sits past Categories / Amount
          Routing, which auto-save on their own. */}
      <div
        className={`flex items-center gap-3 border-t border-neutral-100 dark:border-neutral-800 pt-4 ${isOwner ? "justify-between" : "justify-end"}`}
      >
        {/* Deleting a bucket is owner-only, same as rename/cap/type
            (deleteBucket enforces it server-side). */}
        {isOwner && (
        <button
          type="button"
          onClick={() => {
            if (!confirm(`Delete "${bucket.name}"? Its transactions stay, moved back to Needs a Bucket.`)) return;
            startDeleteTransition(async () => {
              try {
                await deleteBucket(bucket.id);
                showToast("Bucket Deleted");
                router.push("/buckets");
              } catch {
                showToast("Something Went Wrong", "error");
              }
            });
          }}
          disabled={deletePending}
          className="flex items-center gap-1.5 rounded-lg border border-red-300 px-3 py-2 text-sm font-medium text-red-600 hover:bg-red-50 disabled:opacity-50 dark:border-red-900 dark:text-red-400 dark:hover:bg-red-950/40"
        >
          <Trash2 size={14} />
          {deletePending ? "Deleting…" : "Delete Bucket"}
        </button>
        )}
        <button
          type="submit"
          form={formId}
          disabled={pending}
          aria-label="Save Settings"
          title="Save Settings"
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-blue-900 text-white disabled:opacity-50 dark:bg-blue-700"
        >
          {pending ? <span aria-hidden>…</span> : <Check size={16} />}
        </button>
      </div>
    </div>
  );
}

// Reshapes the full owner-facing override map (userId -> type -> lock) down
// to what BucketAlertRecipients needs for one specific type (userId ->
// choice), defaulting a member with no entry to "Default."
function overridesForType(
  alertOverrides: BucketAlertOverridesByUser,
  type: BucketAlertOverrideType,
): Record<string, BucketAlertOverrideChoice> {
  const result: Record<string, BucketAlertOverrideChoice> = {};
  for (const [userId, byType] of Object.entries(alertOverrides)) {
    result[userId] = byType[type] ?? "DEFAULT";
  }
  return result;
}

// A non-owner's own read of BucketAlertRecipients' effect on them — the same
// LockableSwitch the owner locked, shown locked and inert in whichever
// position it was locked (household request, 2026-09-12: "regardless if
// on/off"; restyled 2026-10-03). Renders nothing when this member has no lock
// for this type — the plain checkbox above already says everything there is
// to say in that case.
function LockedAlertNote({ lock }: { lock: "ALWAYS" | "NEVER" | undefined }) {
  if (!lock) return null;
  return (
    <p className="ml-6 flex items-center gap-2 text-xs text-gray-500 dark:text-neutral-400">
      <LockableSwitch
        checked={lock === "ALWAYS"}
        locked
        onToggle={() => {}}
        ariaLabel="This bucket's alert for you"
      />
      Locked {lock === "ALWAYS" ? "on" : "off"} for you by the owner
    </p>
  );
}

// Shared collapse-and-remember shell for every optional/secondary block in
// this panel (AI Assist, Alerts, Amount Routing) — a bordered box with a
// filled header row reads as an accordion you can tap, unlike a bare label +
// small chevron (household report, 2026-09-14: the plain-text AI Assist
// header didn't look clickable at all). Collapsed by default for all three:
// each is optional/secondary, and starting collapsed keeps the panel from
// opening into a wall of fields most sessions never touch. Content stays
// mounted while collapsed (hidden via CSS, not unmounted) — Alerts' own
// checkboxes submit via `form={formId}` from outside the <form> element, and
// AI Assist's textarea would otherwise silently clear a bucket's existing
// aiInstructions on save whenever nobody happened to expand it first (see
// updateBucketSettings, ./actions.ts, which treats a missing field as
// "clear it").
function CollapsibleSection({
  storageKey,
  title,
  children,
}: {
  storageKey: string;
  title: string;
  children: React.ReactNode;
}) {
  const [expanded, setExpanded] = useStoredBoolean(storageKey, false);
  return (
    <div className="overflow-hidden rounded-lg border border-neutral-200 dark:border-neutral-800">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
        className="flex w-full items-center justify-between gap-2 bg-neutral-50 px-3 py-2.5 text-left text-sm font-medium hover:bg-neutral-100 dark:bg-neutral-900 dark:hover:bg-neutral-800"
      >
        {title}
        <ChevronDown
          size={16}
          className={`shrink-0 text-neutral-400 dark:text-neutral-500 transition-transform ${
            expanded ? "rotate-180" : ""
          }`}
        />
      </button>
      <div className={expanded ? "flex flex-col gap-2 px-3 pb-3 pt-2.5" : "hidden"}>{children}</div>
    </div>
  );
}

// The View-Only counterpart to an editable field, for the four owner-only
// settings (Name/type/cap/threshold — household request, 2026-09-12). The
// hidden input (when given) carries the bucket's current value through the
// submit unchanged — belt-and-suspenders alongside updateBucketSettings'
// own server-side enforcement, which ignores these fields from a non-owner
// submit regardless of what's actually in the FormData.
function ReadOnlyField({
  label,
  value,
  hiddenName,
  hiddenValue,
}: {
  label: string;
  value: string;
  hiddenName?: string;
  hiddenValue?: string;
}) {
  return (
    <div className="flex flex-col gap-1.5 text-sm font-medium">
      <span className="text-gray-500 dark:text-neutral-400">{label}</span>
      <p className="rounded-lg border border-neutral-200 bg-neutral-50 px-3 py-2.5 text-base font-normal text-neutral-700 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-300">
        {value}
      </p>
      {hiddenName && <input type="hidden" name={hiddenName} value={hiddenValue ?? value} />}
    </div>
  );
}

// Read / edit / remove list of the amount-bounded merchant rules routing
// *into* this bucket — created from a transaction's Move panel ("only route
// QuikStop here under $15"), shown here so they're not invisible. Editing a
// rule's destination to another bucket drops it from this list (it now shows
// on that bucket's settings instead). No add form: the natural moment to
// make one is when you're looking at a misfiled charge.
function AmountRoutingList({
  bucketId,
  rules,
  buckets,
}: {
  bucketId: string;
  rules: AmountRoutingRule[];
  buckets: { id: string; name: string }[];
}) {
  const router = useRouter();
  const [items, setItems] = useState(rules);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const bucketName = (id: string) => buckets.find((b) => b.id === id)?.name ?? "this bucket";

  if (items.length === 0) return null;

  return (
    <ul className="flex flex-col gap-1.5">
      {items.map((r) =>
        editingId === r.id ? (
          <AmountRoutingEditRow
            key={r.id}
            rule={r}
            currentBucketId={bucketId}
            buckets={buckets}
            pending={pending && busyId === r.id}
            onCancel={() => setEditingId(null)}
            onSave={(amountDollars, toBucketId) => {
              setBusyId(r.id);
              startTransition(async () => {
                const res = await updateAmountRoutingRule({ ruleId: r.id, bucketId: toBucketId, amountDollars });
                setBusyId(null);
                if (res?.error) return; // surfaced inline by the row
                setEditingId(null);
                showToast("Routing Rule Saved");
                if (toBucketId === bucketId) {
                  const cents = Math.round(parseFloat(amountDollars) * 100);
                  setItems((prev) =>
                    prev.map((x) =>
                      x.id === r.id
                        ? { ...x, ...(x.amountMinCents > 0 ? { amountMinCents: cents } : { amountMaxCents: cents }) }
                        : x,
                    ),
                  );
                } else {
                  setItems((prev) => prev.filter((x) => x.id !== r.id));
                }
                router.refresh();
              });
            }}
          />
        ) : (
          <li
            key={r.id}
            className="flex items-center justify-between gap-2 rounded-lg border border-neutral-200 dark:border-neutral-800 px-3 py-2 text-sm"
          >
            <span className="min-w-0 truncate">
              <span className="font-medium capitalize">{r.merchant}</span>
              <span className="text-gray-500 dark:text-neutral-400">
                {" "}
                {r.amountMinCents > 0
                  ? `over ${formatCents(r.amountMinCents)}`
                  : `under ${formatCents(r.amountMaxCents)}`}{" "}
                → {bucketName(bucketId)}
              </span>
            </span>
            <span className="flex shrink-0 items-center gap-2">
              <button
                type="button"
                onClick={() => setEditingId(r.id)}
                disabled={pending}
                aria-label={`Edit Amount Routing For ${r.merchant}`}
                className="text-neutral-500 dark:text-neutral-400 hover:text-neutral-800 dark:hover:text-neutral-200 disabled:opacity-50"
              >
                <Pencil size={14} />
              </button>
              <button
                type="button"
                onClick={() => {
                  if (!confirm(`Remove this routing rule for "${r.merchant}"?`)) return;
                  setBusyId(r.id);
                  startTransition(async () => {
                    await removeAmountRoutingRule(r.id);
                    setItems((prev) => prev.filter((x) => x.id !== r.id));
                    setBusyId(null);
                    showToast("Routing Rule Removed");
                  });
                }}
                disabled={pending}
                aria-label={`Remove Amount Routing For ${r.merchant}`}
                className="text-red-600 dark:text-red-400 disabled:opacity-50"
              >
                {busyId === r.id ? <span aria-hidden>…</span> : <Trash2 size={14} />}
              </button>
            </span>
          </li>
        ),
      )}
    </ul>
  );
}

function AmountRoutingEditRow({
  rule,
  currentBucketId,
  buckets,
  pending,
  onCancel,
  onSave,
}: {
  rule: AmountRoutingRule;
  currentBucketId: string;
  buckets: { id: string; name: string }[];
  pending: boolean;
  onCancel: () => void;
  onSave: (amountDollars: string, toBucketId: string) => void;
}) {
  // Direction is fixed at creation — an "over $X" rule (min edge set) stays
  // "over" here; to flip it, remove the rule and re-add from a transaction.
  const isOver = rule.amountMinCents > 0;
  const [amountDollars, setAmountDollars] = useState(
    ((isOver ? rule.amountMinCents : rule.amountMaxCents) / 100).toString(),
  );
  const [toBucketId, setToBucketId] = useState(currentBucketId);

  const valid = parseFloat(amountDollars) > 0;

  return (
    <li className="flex flex-col gap-2 rounded-lg border border-blue-200 dark:border-blue-900 px-3 py-2.5 text-sm">
      <span className="text-xs text-gray-500 dark:text-neutral-400">
        <span className="font-medium capitalize text-neutral-700 dark:text-neutral-300">{rule.merchant}</span>{" "}
        {isOver ? "over" : "under"}
      </span>
      <div className="flex items-center gap-2">
        <MoneyInput
          defaultCents={Math.round((parseFloat(amountDollars) || 0) * 100) || undefined}
          onValueChange={setAmountDollars}
          aria-label={`Route ${rule.merchant} here only ${isOver ? "over" : "under"} this dollar amount`}
          className="w-24 border-b border-neutral-300 dark:border-neutral-600 bg-transparent py-0.5 text-center tabular-nums focus:border-blue-700 focus:outline-none"
        />
        <span className="text-gray-500 dark:text-neutral-400">→</span>
        <SelectField
          value={toBucketId}
          onChange={setToBucketId}
          small
          options={buckets.map((b) => ({ value: b.id, label: b.name }))}
          className="min-w-0 flex-1"
        />
      </div>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => onSave(amountDollars, toBucketId)}
          disabled={pending || !valid}
          className="rounded-lg bg-blue-900 dark:bg-blue-700 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
        >
          {pending ? "…" : "Save"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={pending}
          className="rounded-lg border border-neutral-300 dark:border-neutral-700 px-3 py-1.5 text-xs font-medium disabled:opacity-50"
        >
          Cancel
        </button>
      </div>
    </li>
  );
}

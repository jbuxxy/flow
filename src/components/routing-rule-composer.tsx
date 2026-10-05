"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Sparkles } from "lucide-react";
import { previewRoutingRuleAction, applyRoutingRuleAction } from "@/app/buckets/actions";
import { showToast } from "@/lib/toast";
import type { RoutingRulePreview } from "@/lib/routing-rules";
import { formatCents } from "@/lib/money";

// The plain-language front door to amount routing: the household types
// something like "gas station purchases under $15 should go to a
// convenience bucket, not Fuel" and gets a concrete proposal to confirm —
// which merchants, the threshold, the destination (an existing bucket, or a
// new one with a recommended cap and which caps shift to fund it), and
// whether to re-file matching history. All execution reuses
// setBoundedMerchantRule / reassignTransactionsForMerchant.
export function RoutingRuleComposer({ fromBucketId }: { fromBucketId: string }) {
  const router = useRouter();
  const [text, setText] = useState("");
  const [preview, setPreview] = useState<RoutingRulePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [backfill, setBackfill] = useState(true);
  const [done, setDone] = useState<string | null>(null);
  const [previewing, startPreview] = useTransition();
  const [applying, startApply] = useTransition();

  function runPreview() {
    setError(null);
    setPreview(null);
    setDone(null);
    startPreview(async () => {
      const res = await previewRoutingRuleAction(fromBucketId, text);
      if (res.error) {
        setError(res.error);
        return;
      }
      setPreview(res.preview);
      setExcluded(new Set());
      setBackfill(true);
    });
  }

  function runApply() {
    if (!preview?.target) return;
    const merchants = preview.merchants.filter((m) => !excluded.has(m));
    if (merchants.length === 0) {
      setError("Keep at least one merchant selected.");
      return;
    }
    setError(null);
    startApply(async () => {
      const res = await applyRoutingRuleAction({
        fromBucketId,
        maxCents: preview.maxCents,
        merchants,
        backfill: backfill && preview.backfillCount > 0,
        target:
          preview.target!.kind === "existing"
            ? { kind: "existing", bucketId: preview.target!.bucketId }
            : {
                kind: "new",
                name: preview.target!.name,
                capCents: preview.target!.capCents,
                adjustments: preview.target!.adjustments.map((a) => ({ bucketId: a.bucketId, capCents: a.toCapCents })),
              },
      });
      if (res.error) {
        setError(res.error);
        return;
      }
      const dest =
        preview.target!.kind === "new" ? preview.target!.name : preview.target!.bucketName;
      setDone(
        `Done — ${merchants.length} ${merchants.length === 1 ? "merchant" : "merchants"} now route to ${dest} under ${formatCents(preview.maxCents)}.`,
      );
      setText("");
      setPreview(null);
      showToast("Routing Rule Applied");
      router.refresh();
    });
  }

  const ready = preview?.understood && preview.target;

  return (
    <div className="flex flex-col gap-2">
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={2}
        maxLength={280}
        placeholder='e.g. "Gas station purchases under $15 should go to convenience, not fuel"'
        className="rounded-lg border border-neutral-300 dark:border-neutral-700 bg-transparent px-3 py-2 text-sm font-normal focus:border-blue-900 focus:outline-none"
      />
      <button
        type="button"
        onClick={runPreview}
        disabled={previewing || text.trim().length < 8}
        className="inline-flex items-center justify-center gap-1.5 self-end rounded-lg border border-neutral-300 dark:border-neutral-700 px-3 py-1.5 text-xs font-medium disabled:opacity-50"
      >
        <Sparkles size={13} className={previewing ? "animate-twinkle" : undefined} />
        {previewing ? "Reading…" : "Preview Rule"}
      </button>

      {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}
      {done && <p className="text-xs text-emerald-700 dark:text-emerald-400">{done}</p>}

      {preview && !ready && (
        <p className="text-xs text-gray-500 dark:text-neutral-400">
          {preview.note ?? "I couldn't turn that into a rule — try naming the merchants or the destination bucket."}
        </p>
      )}

      {preview && ready && preview.target && (
        <div className="flex flex-col gap-3 rounded-lg border border-blue-100 dark:border-neutral-800 bg-blue-50/40 dark:bg-neutral-900/40 p-3">
          <p className="text-sm">{preview.restatement}</p>

          <div className="flex flex-col gap-1">
            <p className="text-xs font-medium text-gray-500 dark:text-neutral-400">
              Merchants Under {formatCents(preview.maxCents)}
            </p>
            <div className="flex flex-col gap-1">
              {preview.merchants.map((m) => (
                <label key={m} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={!excluded.has(m)}
                    onChange={(e) => {
                      setExcluded((prev) => {
                        const next = new Set(prev);
                        if (e.target.checked) next.delete(m);
                        else next.add(m);
                        return next;
                      });
                    }}
                    className="accent-blue-700 dark:accent-blue-500"
                  />
                  <span className="capitalize">{m}</span>
                </label>
              ))}
            </div>
          </div>

          {preview.target.kind === "existing" ? (
            <p className="text-sm">
              <span className="text-gray-500 dark:text-neutral-400">Send to </span>
              <span className="font-medium">{preview.target.bucketName}</span>
            </p>
          ) : (
            <div className="flex flex-col gap-1 text-sm">
              <p>
                <span className="text-gray-500 dark:text-neutral-400">New bucket </span>
                <span className="font-medium">{preview.target.name}</span>
                <span className="text-gray-500 dark:text-neutral-400">
                  {" "}
                  · {formatCents(preview.target.capCents)}/mo
                </span>
              </p>
              {preview.target.rationale && (
                <p className="text-xs text-gray-500 dark:text-neutral-400">{preview.target.rationale}</p>
              )}
              {preview.target.adjustments.map((a) => (
                <p key={a.bucketId} className="text-xs text-gray-500 dark:text-neutral-400">
                  {a.bucketName} {formatCents(a.fromCapCents)} → {formatCents(a.toCapCents)}/mo
                </p>
              ))}
              <p className="text-xs text-gray-400 dark:text-neutral-500">Fine-tune any cap later in its bucket settings.</p>
            </div>
          )}

          {preview.backfillCount > 0 && (
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={backfill}
                onChange={(e) => setBackfill(e.target.checked)}
                className="accent-blue-700 dark:accent-blue-500"
              />
              Also re-file {preview.backfillCount} matching {preview.backfillCount === 1 ? "transaction" : "transactions"} already synced
            </label>
          )}

          {preview.note && <p className="text-xs text-amber-700 dark:text-amber-400">{preview.note}</p>}

          <button
            type="button"
            onClick={runApply}
            disabled={applying}
            className="self-end rounded-lg bg-blue-900 dark:bg-blue-700 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            {applying ? "Creating…" : preview.target.kind === "new" ? "Create Bucket & Rule" : "Create Rule"}
          </button>
        </div>
      )}
    </div>
  );
}

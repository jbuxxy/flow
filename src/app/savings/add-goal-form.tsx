"use client";

import { useActionState, useEffect, useRef, useState, useTransition } from "react";
import { Sparkles, TriangleAlert } from "lucide-react";
import { createGoal, planGoal, type CreateGoalState } from "./actions";
import type { GoalPlanMessage, GoalPlanProposal } from "@/lib/ai";
import { formatCents } from "@/lib/money";
import { MoneyInput } from "@/components/money-input";
import { Modal } from "@/components/modal";
import { AddButton } from "@/components/add-button";
import { SelectField } from "@/components/select-field";
import { useActionToast } from "@/lib/use-action-toast";

const initialState: CreateGoalState = {};

function formatSuggestedDate(dateStr: string): string {
  return new Date(`${dateStr}T00:00:00`).toLocaleDateString("en-US", {
    month: "short",
    day: "2-digit",
    year: "numeric",
  });
}

type ChatTurn = { role: "user"; content: string } | { role: "assistant"; proposal: GoalPlanProposal };

function toApiMessages(turns: ChatTurn[]): GoalPlanMessage[] {
  return turns.map((t) => (t.role === "user" ? { role: "user", content: t.content } : { role: "assistant", content: t.proposal.feedback }));
}

// A 3-phase wizard, not a plain form: (1) "describe" — one free-text box,
// no fields to fill in yet; (2) "chat" — a real back-and-forth transcript
// where AI proposes/revises a name/amount/date (estimating real item cost
// with tax/fees when the description implies a specific purchase, and
// honestly flagging when the numbers don't work given the household's real
// income/budget/debt capacity — see planGoalFromDescription, src/lib/ai.ts,
// including saying so plainly and pointing at manual entry when no
// realistic plan exists even with a longer timeframe); (3) "account" — only
// once they're happy with the plan do they pick which account to watch,
// then create for real. Falls back straight to phase "manual" (the classic
// all-fields-at-once form) if the initial AI call fails outright (network,
// rate limit, etc — every household has AI configured, so a null proposal
// here means the call itself broke, not that AI is unavailable) — planGoal
// returns `proposal: null` for that, same failure-resilience pattern as
// every other AI feature in this app.
type Phase = "describe" | "chat" | "account" | "manual";

export function AddGoalForm({ accounts }: { accounts: { id: string; name: string }[] }) {
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<Phase>("describe");
  const [describeText, setDescribeText] = useState("");
  const [replyText, setReplyText] = useState("");
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [planError, setPlanError] = useState<string | null>(null);
  const [planPending, startPlanTransition] = useTransition();
  const [accountId, setAccountId] = useState("");
  const transcriptRef = useRef<HTMLDivElement>(null);

  const [state, formAction, pending] = useActionState(createGoal, initialState);
  const formRef = useRef<HTMLFormElement>(null);

  const latestProposal = [...turns].reverse().find((t): t is Extract<ChatTurn, { role: "assistant" }> => t.role === "assistant")
    ?.proposal ?? null;
  const firstUserMessage = turns.find((t): t is Extract<ChatTurn, { role: "user" }> => t.role === "user")?.content ?? "";

  useEffect(() => {
    transcriptRef.current?.scrollTo({ top: transcriptRef.current.scrollHeight, behavior: "smooth" });
  }, [turns]);

  function resetWizard() {
    setPhase("describe");
    setDescribeText("");
    setReplyText("");
    setTurns([]);
    setPlanError(null);
    setAccountId("");
  }

  useActionToast(pending, state, {
    success: "Goal Created",
    onSuccess: () => {
      resetWizard();
      setOpen(false);
    },
  });

  function resetAndClose() {
    setOpen(false);
    resetWizard();
  }

  function submitDescribe() {
    const text = describeText.trim();
    if (!text) return;
    setPlanError(null);
    startPlanTransition(async () => {
      const result = await planGoal([{ role: "user", content: text }]);
      if (!result.proposal) {
        setPhase("manual");
        return;
      }
      setTurns([{ role: "user", content: text }, { role: "assistant", proposal: result.proposal }]);
      setPhase("chat");
    });
  }

  function submitReply() {
    const text = replyText.trim();
    if (!text) return;
    const nextTurns: ChatTurn[] = [...turns, { role: "user", content: text }];
    setTurns(nextTurns);
    setReplyText("");
    setPlanError(null);
    startPlanTransition(async () => {
      const result = await planGoal(toApiMessages(nextTurns));
      if (!result.proposal) {
        setPlanError("AI is unavailable right now — you can still continue and enter details manually.");
        return;
      }
      setTurns([...nextTurns, { role: "assistant", proposal: result.proposal }]);
    });
  }

  return (
    <>
      <AddButton label="Add a Goal" onClick={() => setOpen(true)} />
      <Modal open={open} onClose={resetAndClose} title="New Goal">
        {phase === "describe" && (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-gray-600 dark:text-neutral-400">
              Describe what you&apos;re saving for — what it is, roughly when you&apos;d like it, and
              anything else that matters (price range you&apos;ve seen, must-haves, etc). AI will turn
              this into a concrete plan.
            </p>
            <textarea
              value={describeText}
              onChange={(e) => setDescribeText(e.target.value)}
              placeholder="e.g. A used Tesla Model 3, hoping to buy within the next year. Open to higher-mileage ones to keep the price down."
              rows={5}
              className="resize-y rounded-lg border border-neutral-300 dark:border-neutral-700 px-3 py-2.5 text-base focus:border-blue-900 focus:outline-none"
            />
            {planError && (
              <p className="text-sm text-red-600 dark:text-red-400" role="alert">
                {planError}
              </p>
            )}
            <button
              type="button"
              onClick={submitDescribe}
              disabled={planPending || !describeText.trim()}
              className="rounded-lg border border-neutral-300 dark:border-neutral-700 px-4 py-2.5 text-sm font-medium disabled:opacity-50"
            >
              {planPending ? "Thinking…" : "Get AI's Take"}
            </button>
          </div>
        )}

        {phase === "chat" && latestProposal && (
          <div className="flex flex-col gap-3">
            <div ref={transcriptRef} className="flex max-h-72 flex-col gap-2 overflow-y-auto pr-1">
              {turns.map((t, i) =>
                t.role === "user" ? (
                  <div key={i} className="ml-8 rounded-2xl rounded-tr-sm bg-blue-900 dark:bg-blue-800 px-3 py-2 text-sm text-white">
                    {t.content}
                  </div>
                ) : (
                  <div
                    key={i}
                    className={`mr-8 rounded-2xl rounded-tl-sm border p-3 ${
                      t.proposal.feasible
                        ? "border-emerald-300 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-950/30"
                        : "border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/30"
                    }`}
                  >
                    <div className="mb-1 flex items-center gap-1.5">
                      {t.proposal.feasible ? (
                        <Sparkles size={13} className="shrink-0 text-emerald-600 dark:text-emerald-400" />
                      ) : (
                        <TriangleAlert size={13} className="shrink-0 text-amber-600 dark:text-amber-400" />
                      )}
                      <span
                        className={`text-xs font-semibold ${t.proposal.feasible ? "text-emerald-800 dark:text-emerald-300" : "text-amber-800 dark:text-amber-300"}`}
                      >
                        {t.proposal.name}
                      </span>
                    </div>
                    <p className="text-sm text-neutral-800 dark:text-neutral-200">
                      {formatCents(t.proposal.targetAmountCents)}
                      {t.proposal.targetDate && ` by ${formatSuggestedDate(t.proposal.targetDate)}`}
                    </p>
                    {t.proposal.costBreakdown && (
                      <p className="mt-1 text-xs italic text-neutral-600 dark:text-neutral-400">{t.proposal.costBreakdown}</p>
                    )}
                    <p className="mt-2 text-sm leading-relaxed text-neutral-800 dark:text-neutral-200">{t.proposal.feedback}</p>
                  </div>
                ),
              )}
            </div>

            <textarea
              value={replyText}
              onChange={(e) => setReplyText(e.target.value)}
              placeholder={
                latestProposal.feasible
                  ? 'Anything to adjust? e.g. "push it back 6 months" or "I found a cheaper one" — or continue below if this works.'
                  : "Want to try a different amount or timeline? Reply here, or enter it manually below."
              }
              rows={2}
              className="resize-y rounded-lg border border-neutral-300 dark:border-neutral-700 px-3 py-2.5 text-base focus:border-blue-900 focus:outline-none"
            />
            {planError && (
              <p className="text-sm text-red-600 dark:text-red-400" role="alert">
                {planError}
              </p>
            )}
            <div className="flex gap-2">
              <button
                type="button"
                onClick={submitReply}
                disabled={planPending || !replyText.trim()}
                className="flex-1 rounded-lg border border-neutral-300 dark:border-neutral-700 px-4 py-2.5 text-sm font-medium disabled:opacity-50"
              >
                {planPending ? "Thinking…" : "Send"}
              </button>
              <button
                type="button"
                onClick={() => setPhase("account")}
                className={`flex-1 rounded-lg border px-4 py-2.5 text-sm font-medium text-white ${
                  latestProposal.feasible ? "border-emerald-700 bg-emerald-700" : "border-neutral-600 bg-neutral-600 dark:border-neutral-500 dark:bg-neutral-500"
                }`}
              >
                {latestProposal.feasible ? "This Works →" : "Enter Details Manually →"}
              </button>
            </div>
          </div>
        )}

        {(phase === "account" || phase === "manual") && (
          <form ref={formRef} action={formAction} className="flex flex-col gap-3">
            {phase === "account" && (
              <button
                type="button"
                onClick={() => setPhase("chat")}
                className="self-start text-xs text-gray-500 dark:text-neutral-400 underline"
              >
                ← Back to AI Review
              </button>
            )}
            <input
              name="name"
              defaultValue={latestProposal?.name ?? ""}
              placeholder="e.g. Tesla down payment"
              required
              className="rounded-lg border border-neutral-300 dark:border-neutral-700 px-3 py-2.5 text-base focus:border-blue-900 focus:outline-none"
            />
            <textarea
              name="description"
              defaultValue={phase === "account" ? firstUserMessage : ""}
              placeholder="What's it for? (optional)"
              rows={3}
              className="resize-y rounded-lg border border-neutral-300 dark:border-neutral-700 px-3 py-2.5 text-base focus:border-blue-900 focus:outline-none"
            />
            <div className="flex flex-col gap-2 sm:flex-row">
              <MoneyInput
                name="targetAmount"
                defaultCents={latestProposal?.targetAmountCents}
                placeholder="Target $"
                required
                className="w-full rounded-lg border border-neutral-300 dark:border-neutral-700 px-3 py-2.5 text-base focus:border-blue-900 focus:outline-none sm:flex-1"
              />
              <input
                name="targetDate"
                type="date"
                defaultValue={latestProposal?.targetDate ?? ""}
                className="w-full rounded-lg border border-neutral-300 dark:border-neutral-700 px-3 py-2.5 text-base focus:border-blue-900 focus:outline-none sm:w-auto"
              />
            </div>
            {accounts.length > 0 && (
              <SelectField
                name="accountId"
                value={accountId}
                onChange={setAccountId}
                large
                placeholder="Watch an Account (Optional)"
                options={[{ value: "", label: "Manual (No Linked Account)" }, ...accounts.map((a) => ({ value: a.id, label: a.name }))]}
              />
            )}
            {accountId && (
              <p className="-mt-1 text-xs text-gray-500 dark:text-neutral-400">
                Progress is measured from whatever&apos;s in the account now — the target is what you want
                to save on top of that.
              </p>
            )}
            {state.error && (
              <p className="text-sm text-red-600 dark:text-red-400" role="alert">
                {state.error}
              </p>
            )}
            <button
              type="submit"
              disabled={pending}
              className="rounded-lg border border-emerald-700 bg-emerald-700 px-4 py-2.5 text-sm font-medium text-white disabled:opacity-50"
            >
              {pending ? "Creating…" : "Create Goal"}
            </button>
          </form>
        )}
      </Modal>
    </>
  );
}

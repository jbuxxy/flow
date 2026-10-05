"use client";

import { useActionState, useRef, useState } from "react";
import { createDebt, type DebtFormState } from "@/app/debts/actions";
import { RevolvingDebtFields } from "@/app/debts/revolving-debt-fields";
import { Modal } from "@/components/modal";
import { useActionToast } from "@/lib/use-action-toast";

const initialState: DebtFormState = {};

// The quick-add-from-a-transaction counterpart to AddDebtForm
// (src/app/debts/add-debt-form.tsx) — opened from TrackAsBillForm's
// "+ Add a new loan/card" picker option instead of a bare-stub inline
// mini-form, so a debt created mid-tracking-a-transaction goes through the
// exact same createDebt action (and RevolvingDebtFields, same fields) that
// Settings uses, rather than a divergent balanceCents:0/aprBasisPoints:0/
// termsConfirmed:false shortcut (household feedback 2026-08-20: the old
// quick-add didn't match what Settings actually asks for). Card/Loan only —
// no BNPL option, since BNPL creation always needs installment-specific
// terms (payment count, cadence, purchase date) this flow was never meant
// to collect, and stays exclusively on AddDebtForm/the BNPL-suggestion
// accept flow. `showDueDay={false}` on RevolvingDebtFields is load-bearing,
// not cosmetic: the surrounding TrackAsBillForm always creates this
// transaction's own DebtPayment immediately after via its own submit, so
// asking for a due date here too would let both try to create one and race
// createDebtPaymentFromTransaction into a false "already has a tracked
// payment" rejection.
export function AddDebtModal({
  open,
  onClose,
  defaultName,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  defaultName: string;
  onCreated: (debt: { id: string; name: string; kind: "CARD" | "LOAN" }) => void;
}) {
  const [state, formAction, pending] = useActionState(createDebt, initialState);
  const [kind, setKind] = useState<"CARD" | "LOAN">("CARD");
  const formRef = useRef<HTMLFormElement>(null);
  // Bumped to remount RevolvingDebtFields (clears its own dueDay state,
  // moot here since showDueDay is false, but kept for parity/safety) and to
  // clear the name input's uncontrolled defaultValue back to defaultName
  // rather than whatever was last typed.
  const [fieldsKey, setFieldsKey] = useState(0);

  useActionToast(pending, state, {
    success: "Debt Added",
    onSuccess: () => {
      if (!state.debtId) return;
      const submittedName = formRef.current ? String(new FormData(formRef.current).get("name") || "") : "";
      onCreated({ id: state.debtId, name: submittedName || defaultName, kind });
      formRef.current?.reset();
      setKind("CARD");
      setFieldsKey((k) => k + 1);
      onClose();
    },
  });

  return (
    <Modal open={open} onClose={onClose} title="Add a Loan or Card">
      <form ref={formRef} action={formAction} className="flex flex-col gap-3">
        <input type="hidden" name="debtType" value="REVOLVING" />
        <div className="flex gap-2 text-sm">
          <label className="flex items-center gap-1.5">
            <input type="radio" name="kind" value="CARD" checked={kind === "CARD"} onChange={() => setKind("CARD")} />
            Card
          </label>
          <label className="flex items-center gap-1.5">
            <input type="radio" name="kind" value="LOAN" checked={kind === "LOAN"} onChange={() => setKind("LOAN")} />
            Loan
          </label>
        </div>

        <input
          name="name"
          key={fieldsKey}
          defaultValue={defaultName}
          placeholder="Name (e.g. Capital One Venture)"
          required
          className="rounded-lg border border-neutral-300 dark:border-neutral-700 px-3 py-2.5 text-base focus:border-blue-900 focus:outline-none"
        />

        <RevolvingDebtFields key={fieldsKey} showDueDay={false} />

        {state.error && (
          <p className="text-sm text-red-600 dark:text-red-400" role="alert">
            {state.error}
          </p>
        )}

        <button
          type="submit"
          disabled={pending}
          className="rounded-lg border border-neutral-300 dark:border-neutral-700 px-4 py-2.5 text-sm font-medium disabled:opacity-50"
        >
          {pending ? "Adding…" : "Add Debt"}
        </button>
      </form>
    </Modal>
  );
}

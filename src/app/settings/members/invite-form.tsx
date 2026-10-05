"use client";

import { useActionState, useRef, useState } from "react";
import { inviteHouseholdMember, type InviteState } from "./actions";
import { SelectField } from "@/components/select-field";
import { useActionToast } from "@/lib/use-action-toast";
import { ACCESS_LEVELS, type AccessLevel } from "@/lib/member-access";

const initialState: InviteState = {};

const INVITE_ACCESS_LEVELS = (["OWNER", "PARTNER", "BASIC"] as const).map((value) => ({
  value,
  label: ACCESS_LEVELS[value].label,
}));

export function InviteForm() {
  const [state, formAction, pending] = useActionState(
    inviteHouseholdMember,
    initialState,
  );
  const [accessLevel, setAccessLevel] = useState<AccessLevel>("PARTNER");
  const formRef = useRef<HTMLFormElement>(null);

  // state.setupUrl (shown below) lives in the action's own return value,
  // not in the form's fields — resetting those doesn't touch it, so the
  // link stays visible to copy even though the inputs clear underneath it.
  useActionToast(pending, state, {
    success: "Invite Link Created",
    onSuccess: () => {
      formRef.current?.reset();
      setAccessLevel("PARTNER");
    },
  });

  return (
    <form
      ref={formRef}
      action={formAction}
      className="flex flex-col gap-4 border-t border-blue-100 dark:border-neutral-800 pt-6"
    >
      <h2 className="text-sm font-semibold text-emerald-700 dark:text-emerald-400">Invite a Member</h2>

      <label className="flex flex-col gap-1.5 text-sm font-medium">
        Access Level
        <SelectField
          name="accessLevel"
          value={accessLevel}
          onChange={(v) => setAccessLevel(v as AccessLevel)}
          options={INVITE_ACCESS_LEVELS}
          searchable={false}
          large
        />
        <span className="text-xs font-normal text-gray-500 dark:text-neutral-400">
          {ACCESS_LEVELS[accessLevel].description}
        </span>
      </label>

      {state.error && (
        <p className="text-sm text-red-600 dark:text-red-400" role="alert">
          {state.error}
        </p>
      )}

      {state.setupUrl && (
        <div className="rounded-lg bg-neutral-100 dark:bg-neutral-800 p-3 text-xs">
          <p className="mb-1 font-medium">
            Invite link — send this to them (lets them set their own name,
            email, and password{state.needsTotp ? ", and two-factor login" : ""};
            works once, expires in 7 days):
          </p>
          <code className="break-all">{state.setupUrl}</code>
        </div>
      )}

      <button
        type="submit"
        disabled={pending}
        className="rounded-lg bg-blue-900 dark:bg-blue-700 px-4 py-2.5 font-medium text-white disabled:opacity-50"
      >
        {pending ? "Creating…" : "Create Invite Link"}
      </button>
    </form>
  );
}

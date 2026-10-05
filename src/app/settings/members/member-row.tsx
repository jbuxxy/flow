"use client";

import { useState, useTransition } from "react";
import { Check, Pencil, Trash2, X } from "lucide-react";
import { updateMember, deleteMember } from "./actions";
import { SelectField } from "@/components/select-field";
import { showToast } from "@/lib/toast";
import { PasswordInput } from "@/components/password-input";
import { ACCESS_LEVELS, ACCESS_LEVEL_OPTIONS, accessLevelFor, type AccessLevel } from "@/lib/member-access";

type Member = {
  id: string;
  // Null until the invitee uses their setup link and supplies these
  // themselves — the owner only ever picks an access level (see
  // inviteHouseholdMember, ./actions.ts).
  name: string | null;
  email: string | null;
  role: "OWNER" | "PARENT" | "CHILD";
  dashboardScope: "FULL" | "BUCKETS_ONLY";
  totpEnabled: boolean;
  // passwordHash still null — invited but hasn't used their setup link yet.
  needsSetup: boolean;
};

export function MemberRow({ member, currentUserId }: { member: Member; currentUserId: string }) {
  const [editing, setEditing] = useState(false);
  const [deletePending, startDeleteTransition] = useTransition();
  const currentLevel = accessLevelFor(member.role, member.dashboardScope);
  const [accessLevel, setAccessLevel] = useState<AccessLevel>(currentLevel);
  const [name, setName] = useState(member.name ?? "");
  const [email, setEmail] = useState(member.email ?? "");
  const [currentPassword, setCurrentPassword] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function resetFields() {
    setName(member.name ?? "");
    setEmail(member.email ?? "");
    setCurrentPassword("");
    setPassword("");
    setConfirmPassword("");
    setAccessLevel(currentLevel);
    setError(null);
  }

  function save() {
    setError(null);
    if (password) {
      if (!currentPassword) {
        setError("Enter your current password to confirm password change.");
        return;
      }
      if (password !== confirmPassword) {
        setError("New passwords do not match.");
        return;
      }
      if (password.length < 12) {
        setError("New password must be at least 12 characters.");
        return;
      }
    }

    startTransition(async () => {
      const result = await updateMember(member.id, {
        name,
        email,
        password,
        currentPassword,
        confirmPassword,
        accessLevel,
      });
      if (result.error) {
        setError(result.error);
      } else {
        setCurrentPassword("");
        setPassword("");
        setConfirmPassword("");
        setEditing(false);
        showToast("Member Saved");
      }
    });
  }

  function remove() {
    if (!confirm(`Remove ${member.name ?? "this pending invite"} from the household? This can't be undone.`)) return;
    startDeleteTransition(async () => {
      const result = await deleteMember(member.id);
      if (result.error) {
        showToast(result.error);
      } else {
        showToast("Member Removed");
      }
    });
  }

  return (
    <li className="rounded-lg border border-blue-100 dark:border-neutral-800 px-3 py-2 text-sm">
      <div className="flex items-center justify-between">
        <span className="text-neutral-900 dark:text-neutral-100">
          {member.name ?? "Pending Invite"}
          {member.email && <span className="text-neutral-400 dark:text-neutral-500"> · {member.email}</span>}
        </span>
        <span className="flex items-center gap-2 text-xs text-gray-500 dark:text-neutral-400">
          {ACCESS_LEVELS[currentLevel].label}
          {member.needsSetup
            ? " · Setup Pending"
            : member.role !== "CHILD" && !member.totpEnabled && " · 2FA Pending"}
          <button
            onClick={() => {
              if (editing) {
                resetFields();
              }
              setEditing((v) => !v);
            }}
            aria-label={editing ? "Cancel Member Edit" : "Edit Member"}
            title={editing ? "Cancel Edit" : "Edit Member"}
            className="text-blue-900 dark:text-blue-300 hover:underline"
          >
            {editing ? <X size={14} /> : <Pencil size={14} />}
          </button>
          {member.id !== currentUserId && (
            <button
              onClick={remove}
              disabled={deletePending}
              aria-label="Remove Member"
              title="Remove Member"
              className="text-red-600 dark:text-red-400 disabled:opacity-50"
            >
              <Trash2 size={14} />
            </button>
          )}
        </span>
      </div>

      {editing && (
        <div className="mt-3 flex flex-col gap-2 border-t border-blue-100 dark:border-neutral-800 pt-3">
          <label className="flex flex-col gap-1 text-xs font-medium">
            Name
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="rounded-lg border border-neutral-300 dark:border-neutral-700 px-3 py-2 text-sm font-normal focus:border-blue-900 focus:outline-none"
            />
          </label>

          <label className="flex flex-col gap-1 text-xs font-medium">
            Email
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="rounded-lg border border-neutral-300 dark:border-neutral-700 px-3 py-2 text-sm font-normal focus:border-blue-900 focus:outline-none"
            />
          </label>

          <label className="flex flex-col gap-1 text-xs font-medium">
            Current Password
            <PasswordInput
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              placeholder="Required to change password"
            />
          </label>

          <label className="flex flex-col gap-1 text-xs font-medium">
            New Password
            <PasswordInput
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Leave blank to keep current"
            />
            <span className="text-[11px] font-normal text-gray-400 dark:text-neutral-500">
              At least 12 characters, if changing it.
            </span>
          </label>

          <label className="flex flex-col gap-1 text-xs font-medium">
            Confirm New Password
            <PasswordInput
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              placeholder="Must match new password"
            />
          </label>

          <label className="flex flex-col gap-1 text-xs font-medium">
            Access Level
            <SelectField
              value={accessLevel}
              onChange={(v) => setAccessLevel(v as AccessLevel)}
              options={ACCESS_LEVEL_OPTIONS}
              searchable={false}
            />
            <span className="text-[11px] font-normal text-gray-400 dark:text-neutral-500">
              {ACCESS_LEVELS[accessLevel].description}
            </span>
          </label>

          <div className="flex items-center justify-end gap-3">
            {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}
            <button
              onClick={save}
              disabled={pending}
              aria-label="Save"
              title="Save"
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-blue-900 text-white disabled:opacity-50 dark:bg-blue-700"
            >
              {pending ? <span aria-hidden>…</span> : <Check size={15} />}
            </button>
          </div>
        </div>
      )}
    </li>
  );
}

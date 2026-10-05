"use client";

import { useState } from "react";
import { Pencil, PencilOff } from "lucide-react";
import type { RowAction } from "@/components/row-actions";

// The "kebab → Edit toggles an inline form, kebab → Cancel collapses it"
// scaffold shared by IncomeRow, BillRow, and AssetRow — factored out after
// the same race condition (a functional setState toggle flipping `editing`
// right back open) turned up independently in more than one of them (real
// report, 2026-09-08). The fix is structural, not just a bugfix: the "Cancel"
// state carries no onClick at all — keepOpen:false lets RowActions' own
// fire() close the drawer, and onOpenChange here is the *only* place
// `editing` ever gets cleared, so the two can't race.
//
// Callers still own submit-success cleanup (`setEditing(false)` +
// `setActionsOpen(false)` after a successful save) — this only centralizes
// the state declarations, the edit/cancel RowAction, and the onOpenChange
// wiring, which is where the actual duplicated risk lived, not the whole
// row's behavior.
export function useKebabEditRow(editLabel: string = "Edit") {
  const [editing, setEditing] = useState(false);
  const [actionsOpen, setActionsOpen] = useState(false);

  const editAction: RowAction = {
    key: "edit",
    icon: editing ? PencilOff : Pencil,
    label: editing ? "Cancel" : editLabel,
    keepOpen: !editing,
    onClick: editing ? undefined : () => setEditing(true),
  };

  const rowActionsProps = {
    open: actionsOpen,
    pinned: editing,
    onOpenChange: (v: boolean) => {
      setActionsOpen(v);
      if (!v) setEditing(false);
    },
  };

  return { editing, setEditing, actionsOpen, setActionsOpen, editAction, rowActionsProps };
}

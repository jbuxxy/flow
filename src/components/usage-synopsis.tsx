"use client";

import { ChevronDown } from "lucide-react";
import { useStoredBoolean } from "@/lib/use-stored-boolean";

export type UsageSynopsisFeature = { title: string; description: React.ReactNode };

// Shared shell for every settings page's collapsible "How X Is Used" card
// (AI, email, notifications, connected accounts, income, members, household)
// — collapsed-by-default (useStoredBoolean), collapsed state shows just the
// feature titles as a summary line, expanded shows the intro paragraph plus
// the full feature list. Was reimplemented seven times, identically apart
// from the heading, storage key, intro paragraph, and feature list — see
// WORKING_ON.md.
export function UsageSynopsis({
  storageKey,
  title,
  intro,
  features,
  outro,
}: {
  storageKey: string;
  title: string;
  // Most callers have one; income-usage-synopsis.tsx doesn't (the feature
  // list speaks for itself there).
  intro?: React.ReactNode;
  features: UsageSynopsisFeature[];
  // A closing paragraph after the feature list — most callers don't need
  // one (the intro says everything), but settings/ai's does (a fail-open
  // note that applies to the whole list, not any one feature).
  outro?: React.ReactNode;
}) {
  const [expanded, setExpanded] = useStoredBoolean(storageKey, false);

  return (
    <section className="rounded-xl border border-blue-100 dark:border-neutral-800 p-4">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
        className="flex w-full items-center justify-between gap-3 text-left"
      >
        <h2 className="text-base font-semibold text-emerald-700 dark:text-emerald-400">{title}</h2>
        <ChevronDown
          size={18}
          className={`shrink-0 text-neutral-400 dark:text-neutral-500 transition-transform ${expanded ? "rotate-180" : ""}`}
        />
      </button>

      {!expanded && (
        <p className="mt-1.5 text-sm text-gray-500 dark:text-neutral-400">
          {features.map((f) => f.title).join(" · ")}
        </p>
      )}

      {expanded && (
        <>
          {intro && <p className="mt-1.5 text-sm text-gray-600 dark:text-neutral-400">{intro}</p>}
          <ul className="mt-3 flex flex-col gap-2.5 text-sm text-gray-600 dark:text-neutral-400">
            {features.map((f) => (
              <li key={f.title}>
                <span className="font-medium text-neutral-900 dark:text-neutral-100">{f.title} —</span>{" "}
                {f.description}
              </li>
            ))}
          </ul>
          {outro && <p className="mt-3 text-sm text-gray-600 dark:text-neutral-400">{outro}</p>}
        </>
      )}
    </section>
  );
}

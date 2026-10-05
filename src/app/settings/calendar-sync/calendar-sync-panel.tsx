"use client";

import { useState, useTransition } from "react";
import { Copy, Check, RefreshCw } from "lucide-react";
import { regenerateCalendarFeedUrl } from "./actions";
import { showToast } from "@/lib/toast";

export function CalendarSyncPanel({ initialUrl }: { initialUrl: string }) {
  const [httpsUrl, setHttpsUrl] = useState(initialUrl);
  const [pending, startTransition] = useTransition();
  const [copied, setCopied] = useState(false);

  const webcalUrl = httpsUrl.replace(/^https?:\/\//, "webcal://");

  function copy() {
    navigator.clipboard.writeText(httpsUrl).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  function regenerate() {
    if (
      !confirm(
        "Get a new link? The current one will stop working right away, and any calendar already subscribed to it will need the new link.",
      )
    ) {
      return;
    }
    startTransition(async () => {
      try {
        const next = await regenerateCalendarFeedUrl();
        setHttpsUrl(next);
        setCopied(false);
        showToast("New Calendar Link Generated");
      } catch {
        showToast("Something Went Wrong", "error");
      }
    });
  }

  return (
    <div className="rounded-2xl border border-blue-100 dark:border-neutral-800 p-4">
      <h2 className="text-sm font-semibold text-emerald-700 dark:text-emerald-400">Payment Calendar</h2>
      <p className="mt-1 text-xs text-gray-500 dark:text-neutral-400">
        Subscribe to this link from Google or Apple Calendar to see the next 3 months of expected payments —
        every recurring bill and subscription, every debt minimum, and the payoff plan&apos;s extra payments when
        it&apos;s enabled — alongside the rest of your schedule. It only includes payment dates and amounts, no
        other household data. Google and Apple both refresh a subscribed calendar every several hours, not
        instantly. The same one-click Google and Apple buttons are on the Payment Calendar on your dashboard.
      </p>

      <div className="mt-3 flex flex-col gap-2">
        <a
          href={webcalUrl}
          className="rounded-lg bg-blue-900 dark:bg-blue-700 px-4 py-2.5 text-center text-sm font-medium text-white"
        >
          Add to Calendar App
        </a>

        <div className="flex items-center gap-2 rounded-lg bg-neutral-100 dark:bg-neutral-800 p-3 text-xs">
          <code className="flex-1 break-all">{httpsUrl}</code>
          <button
            type="button"
            onClick={copy}
            aria-label={copied ? "Copied" : "Copy Link"}
            title={copied ? "Copied" : "Copy Link"}
            className="shrink-0 text-blue-900 dark:text-blue-300"
          >
            {copied ? <Check size={15} className="animate-draw-check" /> : <Copy size={15} />}
          </button>
        </div>
        <p className="text-xs text-gray-500 dark:text-neutral-400">
          Paste the link above into Google Calendar under &quot;Other calendars → From URL.&quot;
        </p>
      </div>

      <button
        type="button"
        onClick={regenerate}
        disabled={pending}
        title="Get a New Link"
        className="mt-3 flex items-center gap-1.5 text-xs font-medium text-red-600 dark:text-red-400 disabled:opacity-50"
      >
        <RefreshCw size={13} className={pending ? "animate-spin" : undefined} />
        {pending ? "Generating…" : "Get a New Link (Invalidates This One)"}
      </button>
    </div>
  );
}

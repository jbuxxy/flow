"use client";

import { useState } from "react";

// The "Add to Google / Apple Calendar" one-click buttons for the household's
// ICS feed (see /api/calendar/[token] and src/lib/calendar-feed-url.ts).
// Lives next to the dashboard's Payment Calendar card; the full copy-the-link
// / rotate-the-token flow is on /settings/calendar-sync. `feedUrl` is the
// https:// form, resolved server-side and passed down — owner-only, so a
// non-owner never renders this at all (the caller passes null). One feed:
// the full payment calendar (bills, subscriptions, debt minimums, and payoff
// extras when the plan is on).
export function CalendarSubscribeButtons({ feedUrl }: { feedUrl: string }) {
  const [googleMobileHint, setGoogleMobileHint] = useState(false);
  const webcalUrl = feedUrl.replace(/^https?:\/\//, "webcal://");

  return (
    <div className="relative flex items-center gap-1.5">
      <a
        href={`https://www.google.com/calendar/render?cid=${encodeURIComponent(webcalUrl)}`}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(e) => {
          // Google's Android/iOS apps have no "subscribe by URL" feature at
          // all — that's a desktop-web-only flow, so this link just
          // dead-ends on the app's default view on mobile no matter which
          // Google domain it points at. Copy the link and tell the user
          // where to paste it instead of sending them somewhere that can't
          // use it.
          if (!/Android|iPhone|iPad|iPod/i.test(navigator.userAgent)) return;
          e.preventDefault();
          navigator.clipboard.writeText(feedUrl).catch(() => {});
          setGoogleMobileHint(true);
          setTimeout(() => setGoogleMobileHint(false), 6000);
        }}
        aria-label="Add to Google Calendar"
        title="Add to Google Calendar"
        className="flex items-center rounded-md border border-blue-100 dark:border-neutral-800 p-1.5"
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/icons/google-logo.png" alt="" className="h-4 w-4" />
      </a>
      <a
        href={webcalUrl}
        aria-label="Add to Apple Calendar"
        title="Add to Apple Calendar"
        className="flex items-center rounded-md border border-blue-100 dark:border-neutral-800 p-1.5"
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/icons/apple-logo.png" alt="" className="h-4 w-4" />
      </a>
      {googleMobileHint && (
        <div className="absolute right-0 top-full z-[var(--z-overlay)] mt-2 w-56 rounded-lg border border-blue-100 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-2.5 text-xs text-neutral-600 dark:text-neutral-300 shadow-lg">
          Link copied. In the Google Calendar app: Settings → Add calendar → From URL, then paste it.
        </div>
      )}
    </div>
  );
}

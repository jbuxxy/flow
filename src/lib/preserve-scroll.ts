"use client";

// Runs a server action that revalidates the current page and puts the window
// back where it was afterwards. Re-bucketing a transaction on /transactions
// threw the household back to the top of the list after every pick (household
// report, 2026-10-04), so working down a long list meant scrolling back after
// each one. The refreshed render lands a frame or two after the action
// resolves, so the restore is re-applied over a short window, and only if the
// page actually moved (a row leaving a filtered list shifts content by a row's
// height, which is expected and left alone).
export async function preservingScroll<T>(action: () => Promise<T>): Promise<T> {
  if (typeof window === "undefined") return action();
  const y = window.scrollY;
  const result = await action();
  const restore = () => {
    if (Math.abs(window.scrollY - y) > 200) window.scrollTo({ top: y, behavior: "instant" as ScrollBehavior });
  };
  requestAnimationFrame(() => requestAnimationFrame(restore));
  setTimeout(restore, 150);
  setTimeout(restore, 400);
  return result;
}

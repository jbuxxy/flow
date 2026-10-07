import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // Every next/image usage in this app is one of our own pre-sized static
  // icons under public/icons (see src/scripts/gen-icons.py) — never a
  // remote or variable-size image — so there's nothing for the built-in
  // optimizer to actually do. Turning it off avoids a real production bug:
  // the runner container runs as a non-root user (see Dockerfile) that
  // can't write .next/cache/images, and under concurrent requests for the
  // same URL (the `priority` prop's preload link plus the <img> tag itself)
  // the optimizer would hang rather than cleanly falling back.
  images: {
    unoptimized: true,
  },
  // imapflow/mailparser are Node-only (native-ish streams, no browser
  // build) and are used exclusively from server code (src/lib/email-provider.ts,
  // src/lib/receipt-*.ts) — keep Turbopack from trying to bundle them the
  // way it does app code.
  serverExternalPackages: ["imapflow", "mailparser"],
  // Every route here is session-gated and DB-backed (auth() reads cookies,
  // so nothing is genuinely static) — but Next's client-side navigation
  // cache doesn't know that, and its default `static` staleTime (5 min)
  // still applies to a route you're revisiting (e.g. tapping back to a
  // bottom-nav tab you already loaded this session). That's what was
  // freezing the profile icon's red "needs attention" dot: it reflects
  // live DB state (app-shell.tsx), but a revisited tab was serving Next's
  // up-to-5-minutes-old cached render instead of recomputing it, so the
  // dot didn't reliably track newly-arrived issues (a background SimpleFIN
  // sync, a due date rolling over, etc.) as you moved between tabs. Forcing
  // both staleTimes to 0 makes every navigation refetch fresh server data,
  // which is what a real-money app should do anyway.
  // Baseline hardening headers on every response. No CSP yet: Next's inline
  // bootstrap scripts (and layout.tsx's pre-paint theme script) would need
  // nonces threaded through the proxy first.
  // - frame-ancestors/X-Frame-Options: nothing here is meant to be embedded,
  //   and a framed money app is a clickjacking target.
  // - Referrer-Policy: setup/invite tokens ride in the URL (/setup-totp
  //   ?token=…) — never leak a path+query to another origin.
  // The Accounts settings page lived at /settings/simplefin until
  // 2026-10-07 — already-sent notification links and bookmarks still point
  // there.
  async redirects() {
    return [{ source: "/settings/simplefin", destination: "/settings/accounts", permanent: true }];
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
        ],
      },
    ];
  },
  experimental: {
    staleTimes: {
      dynamic: 0,
      // Next requires static >= 30s; this is the floor, not a deliberate
      // "still allow half a minute of staleness" choice.
      static: 30,
    },
  },
};

export default nextConfig;

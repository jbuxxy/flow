import type { NextAuthConfig } from "next-auth";

// Edge-safe base config, used directly by middleware. Must NOT import
// anything that pulls in Node-only native deps (argon2, otplib, pg/Prisma) —
// those live only in auth.ts, which runs in the Node.js runtime.
const PUBLIC_PATHS = ["/login", "/register", "/setup-totp", "/invite"];

export default {
  pages: { signIn: "/login" },
  session: { strategy: "jwt" },
  // Required for self-hosted deployments sitting behind a reverse proxy
  // (Cloudflare -> NPM -> this container) — otherwise Auth.js rejects the
  // forwarded Host header as untrusted. Safe here because NPM/Cloudflare are
  // the only ingress path; this container is never directly internet-facing.
  trustHost: true,
  providers: [],
  callbacks: {
    authorized({ auth, request }) {
      const { pathname } = request.nextUrl;

      // The public example household (see Household.isDemo) is strictly
      // read-only. Every mutating server action is an HTTP POST through this
      // proxy carrying a `Next-Action` header; blocking POST here (except
      // NextAuth's own routes, so sign-out still works) is the single
      // chokepoint that guarantees no write can land for a demo session —
      // present or future actions — without a guard on each of the ~40
      // individual server actions. GET-render lazy writes are handled
      // separately by isDemoHousehold() (src/lib/demo.ts).
      if (
        auth?.user?.isDemo &&
        request.method === "POST" &&
        !pathname.startsWith("/api/auth")
      ) {
        return Response.json(
          { error: "The example household is read-only." },
          { status: 403 },
        );
      }

      const isPublic =
        pathname === "/" || // page.tsx itself decides: /register (no household yet) or /login
        PUBLIC_PATHS.some((p) => pathname.startsWith(p)) ||
        pathname.startsWith("/api/auth") ||
        // The debt-payoff ICS feed (see /api/calendar/[token]/route.ts) is
        // deliberately public — a subscribing calendar app has no way to
        // send a session cookie, so the token in the URL path is its own
        // credential (see Household.calendarFeedToken's schema comment).
        // The route itself 404s on an unknown/missing token.
        pathname.startsWith("/api/calendar") ||
        // Both halves of a fully passwordless passkey login
        // (src/app/api/webauthn/login-options + login-verify) necessarily
        // run before any session exists — the whole point is to hand back
        // the token that CREATES one, with no email/password ever entered.
        // Every other /api/webauthn/* route (registering a new passkey,
        // from Settings) stays behind the normal auth gate below.
        pathname === "/api/webauthn/login-options" ||
        pathname === "/api/webauthn/login-verify" ||
        pathname.startsWith("/manifest.webmanifest") ||
        pathname.startsWith("/sw.js") ||
        pathname.startsWith("/icons") ||
        pathname === "/favicon.ico";
      if (isPublic) return true;
      return !!auth?.user;
    },
    jwt({ token, user }) {
      if (user) {
        token.id = (user as { id: string }).id;
        token.role = (user as { role: string }).role;
        token.householdId = (user as { householdId: string }).householdId;
        token.dashboardScope = (user as { dashboardScope: string }).dashboardScope;
        token.isDemo = (user as { isDemo?: boolean }).isDemo === true;
      }
      return token;
    },
    session({ session, token }) {
      if (session.user) {
        session.user.id = token.id as string;
        session.user.role = token.role as string;
        session.user.householdId = token.householdId as string;
        session.user.dashboardScope = token.dashboardScope as string;
        session.user.isDemo = token.isDemo === true;
      }
      return session;
    },
  },
} satisfies NextAuthConfig;

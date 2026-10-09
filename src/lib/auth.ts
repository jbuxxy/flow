import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import authConfig from "@/lib/auth.config";
import { db } from "@/lib/db";
import { verifyPassword } from "@/lib/password";
import { decrypt } from "@/lib/crypto";
import { claimTotpCode } from "@/lib/totp";
import { decodeLoginVerifiedToken } from "@/lib/webauthn-token";
import { applyLiveClaims } from "@/lib/session-claims";
import {
  isLocked,
  recordFailedLogin,
  recordSuccessfulLogin,
} from "@/lib/login-lockout";

// Full config — Node.js runtime only (route handlers, server components,
// server actions). Never imported by middleware.ts; see auth.config.ts for
// the edge-safe subset that middleware actually uses.
export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  callbacks: {
    ...authConfig.callbacks,
    // Node-only override of the edge-safe jwt callback: on every auth() call
    // after sign-in, refresh role/household/scope from the DB and end the
    // session if the user no longer exists (see session-claims.ts). The edge
    // proxy still runs the base callback (no DB there), but it only gates
    // "signed in at all" — every data read and server action goes through
    // this auth().
    async jwt(params) {
      const token = authConfig.callbacks.jwt(params);
      if (params.user || typeof token.id !== "string") return token;
      const user = await db.user.findUnique({
        where: { id: token.id },
        select: {
          role: true,
          householdId: true,
          dashboardScope: true,
          household: { select: { isDemo: true } },
        },
      });
      return applyLiveClaims(token, user);
    },
  },
  providers: [
    Credentials({
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
        totpCode: { label: "Authenticator code", type: "text" },
        webauthnToken: { label: "Passkey verification", type: "text" },
        demo: { label: "Demo", type: "text" },
      },
      async authorize(credentials) {
        // The /login "View the Example Household" button. Structurally can't
        // return a non-demo user — the query is hard-pinned to
        // household.isDemo and no caller input selects the row — so this can't
        // be used as a back door into a real household. The demo user is
        // OWNER with totpEnabled:false, which the normal password path below
        // rejects outright (see the totpRequired check), so this branch is
        // the *only* way it's ever admitted.
        if (typeof credentials?.demo === "string" && credentials.demo === "1") {
          const demoUser = await db.user.findFirst({
            where: { household: { isDemo: true } },
            orderBy: { createdAt: "asc" },
          });
          if (!demoUser) return null;
          await db.auditLog.create({
            data: { userId: demoUser.id, action: "DEMO_LOGIN" },
          });
          return {
            id: demoUser.id,
            email: demoUser.email,
            name: demoUser.name,
            role: demoUser.role,
            householdId: demoUser.householdId,
            dashboardScope: demoUser.dashboardScope,
            isDemo: true,
          };
        }

        const webauthnToken =
          typeof credentials?.webauthnToken === "string" && credentials.webauthnToken
            ? credentials.webauthnToken
            : null;

        // Fully passwordless — a passkey (Face ID/Touch ID/Windows Hello)
        // IS the entire sign-in, not a second factor layered on a password.
        // webauthnToken only ever exists via POST /api/webauthn/login-verify
        // having just checked a real WebAuthn assertion against a
        // credential already on file; the userId it names comes from that
        // credential's own `@unique` owner (decodeLoginVerifiedToken), never
        // from anything the client separately claims. email/password/
        // totpCode are irrelevant on this path and never even read.
        if (webauthnToken) {
          const decoded = decodeLoginVerifiedToken(webauthnToken);
          if (!decoded) return null;

          const user = await db.user.findUnique({ where: { id: decoded.userId } });
          if (!user) return null;
          if (isLocked(user)) return null;

          await recordSuccessfulLogin(user.id);
          await db.auditLog.create({
            data: { userId: user.id, action: "LOGIN_SUCCESS", detail: { via: "passkey" } },
          });

          return {
            id: user.id,
            email: user.email,
            name: user.name,
            role: user.role,
            householdId: user.householdId,
            dashboardScope: user.dashboardScope,
          };
        }

        // Password (+ TOTP) fallback — for the first sign-in on a device
        // with no passkey registered yet, or anyone who never set one up.
        const email =
          typeof credentials?.email === "string"
            ? credentials.email.trim().toLowerCase()
            : null;
        const password =
          typeof credentials?.password === "string"
            ? credentials.password
            : null;
        const totpCode =
          typeof credentials?.totpCode === "string"
            ? credentials.totpCode.trim()
            : "";

        if (!email || !password) return null;

        const user = await db.user.findUnique({ where: { email } });
        // Generic failure for unknown users — avoids revealing which emails exist.
        if (!user) return null;

        if (isLocked(user)) return null;

        // Invited but hasn't finished setup yet (User.passwordHash is null
        // until they use their one-time link) — same generic failure as an
        // unknown email, not a distinct "finish your invite" message.
        if (!user.passwordHash) return null;

        const passwordOk = await verifyPassword(user.passwordHash, password);
        if (!passwordOk) {
          await recordFailedLogin(user.id);
          return null;
        }

        // TOTP is mandatory for OWNER/PARENT roles (v1 decision — this app
        // touches real linked bank/debt data). A user who hasn't completed
        // enrollment yet must use their setup link, not the login form.
        const totpRequired = user.role !== "CHILD";
        if (totpRequired && !user.totpEnabled) {
          return null;
        }

        if (user.totpEnabled) {
          if (!user.totpSecretEncrypted || !totpCode) {
            await recordFailedLogin(user.id);
            return null;
          }
          const secret = decrypt(user.totpSecretEncrypted);
          if (!(await claimTotpCode(user, secret, totpCode))) {
            await recordFailedLogin(user.id);
            return null;
          }
        }

        await recordSuccessfulLogin(user.id);
        await db.auditLog.create({
          data: { userId: user.id, action: "LOGIN_SUCCESS" },
        });

        return {
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role,
          householdId: user.householdId,
          dashboardScope: user.dashboardScope,
        };
      },
    }),
  ],
});

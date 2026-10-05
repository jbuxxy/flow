import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  belongsToHousehold,
  canViewAccountBalance,
  canViewNetWorth,
  hasFullAccess,
} from "@/lib/access";
import authConfig from "@/lib/auth.config";

// The proxy's gate (src/proxy.ts runs authConfig.callbacks.authorized on
// every request). Called directly with the two fields it reads.
type AuthorizedArgs = Parameters<typeof authConfig.callbacks.authorized>[0];
function gate(path: string, opts: { method?: string; user?: Record<string, unknown> } = {}) {
  const request = { nextUrl: new URL(path, "https://flow.example.com"), method: opts.method ?? "GET" };
  const auth = opts.user ? { user: opts.user, expires: "" } : null;
  return authConfig.callbacks.authorized({ auth, request } as unknown as AuthorizedArgs);
}

const member = { id: "u1", role: "OWNER", householdId: "h1", dashboardScope: "FULL" };

describe("proxy authorized() gate", () => {
  test("app pages require a session", () => {
    assert.equal(gate("/debts"), false);
    assert.equal(gate("/settings/members"), false);
    assert.equal(gate("/api/push/subscribe", { method: "POST" }), false);
    assert.equal(gate("/debts", { user: member }), true);
  });

  test("auth flows and static assets stay public", () => {
    for (const p of ["/", "/login", "/register", "/setup-totp?token=x", "/invite/abc", "/api/auth/session", "/manifest.webmanifest", "/sw.js", "/favicon.ico"]) {
      assert.equal(gate(p), true, p);
    }
  });

  test("only the two passwordless-login WebAuthn routes are public", () => {
    assert.equal(gate("/api/webauthn/login-options", { method: "POST" }), true);
    assert.equal(gate("/api/webauthn/login-verify", { method: "POST" }), true);
    assert.equal(gate("/api/webauthn/register-options", { method: "POST" }), false);
    assert.equal(gate("/api/webauthn/register-verify", { method: "POST" }), false);
  });

  test("a prefix lookalike doesn't inherit public access", () => {
    assert.equal(gate("/api/webauthn/login-options-admin"), false);
  });

  test("the demo household can't POST anything except sign-out", async () => {
    const demo = { ...member, isDemo: true };
    const blocked = gate("/buckets", { method: "POST", user: demo });
    assert.ok(blocked instanceof Response);
    assert.equal((blocked as Response).status, 403);
    assert.equal(gate("/api/auth/signout", { method: "POST", user: demo }), true);
    assert.equal(gate("/buckets", { user: demo }), true);
    assert.equal(gate("/buckets", { method: "POST", user: member }), true);
  });
});

describe("access helpers", () => {
  test("hasFullAccess: OWNER always, others only with FULL scope", () => {
    assert.equal(hasFullAccess({ role: "OWNER", dashboardScope: "BUCKETS_ONLY" }), true);
    assert.equal(hasFullAccess({ role: "PARENT", dashboardScope: "FULL" }), true);
    assert.equal(hasFullAccess({ role: "PARENT", dashboardScope: "BUCKETS_ONLY" }), false);
    assert.equal(hasFullAccess({ role: "CHILD", dashboardScope: "BUCKETS_ONLY" }), false);
  });

  test("net worth and cash/investment balances are owner-only", () => {
    assert.equal(canViewNetWorth({ role: "OWNER" }), true);
    assert.equal(canViewNetWorth({ role: "PARENT" }), false);
    for (const t of ["CHECKING", "SAVINGS", "INVESTMENT", "OTHER"]) {
      assert.equal(canViewAccountBalance({ role: "PARENT" }, t), false, t);
      assert.equal(canViewAccountBalance({ role: "OWNER" }, t), true, t);
    }
    assert.equal(canViewAccountBalance({ role: "PARENT" }, "CREDIT_CARD"), true);
    assert.equal(canViewAccountBalance({ role: "PARENT" }, "LOAN"), true);
  });

  test("belongsToHousehold rejects missing and foreign records", () => {
    assert.equal(belongsToHousehold({ householdId: "h1" }, "h1"), true);
    assert.equal(belongsToHousehold({ householdId: "h2" }, "h1"), false);
    assert.equal(belongsToHousehold(null, "h1"), false);
    assert.equal(belongsToHousehold(undefined, "h1"), false);
  });
});

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { applyLiveClaims } from "@/lib/session-claims";

describe("applyLiveClaims", () => {
  const token = {
    id: "u1",
    role: "OWNER",
    householdId: "h1",
    dashboardScope: "FULL",
    isDemo: false,
  };

  // 2026-10-05: a deleted member's JWT kept working indefinitely (Auth.js
  // re-signs it on every request).
  test("a deleted user ends the session", () => {
    assert.equal(applyLiveClaims(token, null), null);
  });

  test("a demotion takes effect on the next request", () => {
    const out = applyLiveClaims(token, {
      role: "PARENT",
      householdId: "h1",
      dashboardScope: "BUCKETS_ONLY",
      household: { isDemo: false },
    });
    assert.equal(out?.role, "PARENT");
    assert.equal(out?.dashboardScope, "BUCKETS_ONLY");
    assert.equal(out?.id, "u1");
  });

  test("household and demo flag come from the DB, not the token", () => {
    const out = applyLiveClaims(token, {
      role: "OWNER",
      householdId: "h2",
      dashboardScope: "FULL",
      household: { isDemo: true },
    });
    assert.equal(out?.householdId, "h2");
    assert.equal(out?.isDemo, true);
  });
});

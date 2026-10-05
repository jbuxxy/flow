import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { resolveBnplKeyword } from "@/lib/bnpl-detect";

describe("resolveBnplKeyword", () => {
  test("prefers the stored keyword over re-deriving from name", () => {
    // The whole point (2026-09-11 fix): a debt renamed after its BNPL
    // identity was first established must not fall out of attribution just
    // because its current name no longer contains the keyword.
    assert.equal(resolveBnplKeyword({ name: "Nike Shoes", bnplKeyword: "klarna" }, ["klarna", "affirm"]), "klarna");
  });

  test("falls back to a live name match when nothing is stored yet", () => {
    assert.equal(resolveBnplKeyword({ name: "Nike - Klarna", bnplKeyword: null }, ["klarna", "affirm"]), "klarna");
  });

  test("falls back the same way when bnplKeyword is simply absent from the object", () => {
    assert.equal(resolveBnplKeyword({ name: "Affirm Payment" }, ["klarna", "affirm"]), "affirm");
  });

  test("returns undefined when nothing matches either way", () => {
    assert.equal(resolveBnplKeyword({ name: "Chase Sapphire", bnplKeyword: null }, ["klarna", "affirm"]), undefined);
  });
});

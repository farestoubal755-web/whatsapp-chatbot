// Unit tests for the Legacy Action Adapter (Sprint-1 Task 3).
// Run with: node --test src/router/legacyAdapter.test.js
//
// Rather than hard-coding an assumed count of systemDecision values, this
// file derives the full set directly from the live DECISION_TABLE
// (src/router/decisionTable.js) and asserts every one of them has exactly
// one mapping and exactly one generated test - so if Task 1's table ever
// gains a new systemDecision, this suite fails loudly instead of silently
// under-covering it.

import test from "node:test";
import assert from "node:assert/strict";
import { DECISION_TABLE } from "./decisionTable.js";
import { toLegacyAction, DEFAULT_LEGACY_ACTION } from "./legacyAdapter.js";

// Derive the complete, de-duplicated set of systemDecision values directly
// from the approved decision table - not assumed, not hard-coded.
const decisionsInTable = new Set();
for (const rules of Object.values(DECISION_TABLE)) {
  for (const rule of rules) decisionsInTable.add(rule.decision);
}

const VALID_LEGACY_ACTIONS = new Set(["reply", "search_products", "confirm_order", "handoff"]);

// The intended mapping per decision (matches the approved Task 3 plan).
// Verified below to cover exactly the same set as decisionsInTable -
// neither more nor fewer.
const EXPECTED_MAPPING = {
  LOOKUP_PRODUCT_AND_RESPOND: "search_products",
  LOOKUP_VARIANT_AND_RESPOND: "search_products",
  PRESENT_CANDIDATES: "search_products",
  LOOKUP_DELIVERY_AND_RESPOND: "reply",
  BEGIN_ORDER_COLLECTION: "reply",
  UPDATE_ORDER_INFO: "reply",
  VALIDATE_AND_UPDATE_ORDER_FIELD: "reply",
  FALLBACK_NO_ACTIVE_ORDER: "reply",
  FALLBACK_CLARIFY: "reply",
  FALLBACK_UNKNOWN_INTENT: "reply",
  GREET_RESPOND: "reply",
  LOOKUP_POLICY_AND_RESPOND: "reply",
  CANCEL_ORDER: "reply",
  FRESH_READ_AND_CONFIRM: "confirm_order",
  HANDOFF_TO_HUMAN: "handoff",
};

test("EXPECTED_MAPPING covers exactly the decisions present in the approved DECISION_TABLE - no more, no fewer", () => {
  const fromTable = [...decisionsInTable].sort();
  const fromExpected = Object.keys(EXPECTED_MAPPING).sort();
  assert.deepEqual(fromExpected, fromTable);
});

// One test per decision actually found in the table - generated
// dynamically, so the count always matches the table, never a hard-coded
// number.
for (const decision of decisionsInTable) {
  test(`toLegacyAction(${decision}) maps to the documented legacy action`, () => {
    assert.equal(toLegacyAction(decision), EXPECTED_MAPPING[decision]);
  });
}

test("every mapped legacy action is one of the 4 valid legacy actions", () => {
  for (const decision of decisionsInTable) {
    assert.ok(VALID_LEGACY_ACTIONS.has(toLegacyAction(decision)));
  }
});

test("an unrecognized systemDecision falls back safely to the default action, never throws", () => {
  assert.equal(toLegacyAction("SOME_FUTURE_DECISION_NOT_YET_MAPPED"), DEFAULT_LEGACY_ACTION);
  assert.equal(toLegacyAction(undefined), DEFAULT_LEGACY_ACTION);
  assert.equal(toLegacyAction(""), DEFAULT_LEGACY_ACTION);
});

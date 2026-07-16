// Tests for the Orchestration Layer (Sprint 2).
// Run with: node --test src/orchestration/orchestrate.test.js
//
// No live model call anywhere in this file - understandFn is always a
// fake, injected function, and orchestrate() has no default to fall back
// on. These tests prove the composition logic (understanding -> route ->
// legacyAction wiring) is correct; they prove nothing about real model
// behavior.
//
// The full systemDecision set is derived from the live DECISION_TABLE at
// runtime (same pattern as legacyAdapter.test.js) rather than assumed, so
// this suite stays complete even if the table changes later.

import test from "node:test";
import assert from "node:assert/strict";
import { orchestrate } from "./orchestrate.js";
import { DECISION_TABLE } from "../router/decisionTable.js";
import { toLegacyAction } from "../router/legacyAdapter.js";

const decisionsInTable = new Set();
for (const rules of Object.values(DECISION_TABLE)) {
  for (const rule of rules) decisionsInTable.add(rule.decision);
}

// One triggering scenario per decision, reusing the exact conditions
// already proven correct in route.test.js / route.contract.test.js /
// legacyAdapter.test.js.
const SCENARIOS = {
  LOOKUP_PRODUCT_AND_RESPOND: { understanding: { intent: "product_inquiry", entities: {}, confidence: "high" }, orderState: null },
  LOOKUP_VARIANT_AND_RESPOND: { understanding: { intent: "variant_inquiry", entities: {}, confidence: "high" }, orderState: null },
  PRESENT_CANDIDATES: { understanding: { intent: "product_inquiry", entities: {}, confidence: "medium" }, orderState: null },
  FALLBACK_CLARIFY: { understanding: { intent: "product_inquiry", entities: {}, confidence: "low" }, orderState: null },
  LOOKUP_DELIVERY_AND_RESPOND: { understanding: { intent: "delivery_inquiry", entities: { wilaya: "Alger" }, confidence: "high" }, orderState: null },
  BEGIN_ORDER_COLLECTION: { understanding: { intent: "order_initiate", entities: {}, confidence: "high" }, orderState: null },
  UPDATE_ORDER_INFO: { understanding: { intent: "order_info_provide", entities: {}, confidence: "high" }, orderState: { stage: "collecting_info" } },
  FALLBACK_NO_ACTIVE_ORDER: { understanding: { intent: "order_info_provide", entities: {}, confidence: "high" }, orderState: null },
  FRESH_READ_AND_CONFIRM: { understanding: { intent: "order_confirm", entities: {}, confidence: "high" }, orderState: { stage: "awaiting_confirmation" } },
  VALIDATE_AND_UPDATE_ORDER_FIELD: { understanding: { intent: "order_modify", entities: { modifiedField: "wilaya" }, confidence: "high" }, orderState: null },
  HANDOFF_TO_HUMAN: { understanding: { intent: "complaint", entities: {}, confidence: "high" }, orderState: null },
  CANCEL_ORDER: { understanding: { intent: "order_cancel", entities: {}, confidence: "high" }, orderState: { stage: "collecting_info" } },
  LOOKUP_POLICY_AND_RESPOND: { understanding: { intent: "general_question", entities: {}, confidence: "high" }, orderState: null },
  GREET_RESPOND: { understanding: { intent: "greeting", entities: {}, confidence: "high" }, orderState: null },
  FALLBACK_UNKNOWN_INTENT: { understanding: { intent: "unknown", entities: {}, confidence: "high" }, orderState: null },
};

test("SCENARIOS covers exactly the decisions present in the approved DECISION_TABLE - no more, no fewer", () => {
  const fromTable = [...decisionsInTable].sort();
  const fromScenarios = Object.keys(SCENARIOS).sort();
  assert.deepEqual(fromScenarios, fromTable);
});

for (const decision of decisionsInTable) {
  test(`orchestrate() produces ${decision} with the matching legacyAction`, async () => {
    const { understanding, orderState } = SCENARIOS[decision];
    const fakeUnderstandFn = async () => understanding;
    const result = await orchestrate(
      "test message",
      { orderState, understandingContext: {} },
      { understandFn: fakeUnderstandFn }
    );
    assert.equal(result.systemDecision, decision);
    assert.equal(result.legacyAction, toLegacyAction(decision));
    assert.equal(result.intent, understanding.intent);
    assert.equal(result.confidence, understanding.confidence);
  });
}

test("orchestrate() throws immediately if understandFn is missing", async () => {
  await assert.rejects(() => orchestrate("hi", {}, {}), /requires an injected understandFn/);
});

test("orchestrate() throws immediately if understandFn is not a function", async () => {
  await assert.rejects(() => orchestrate("hi", {}, { understandFn: "not a function" }), /requires an injected understandFn/);
});

test("orchestrate() propagates a rejection from understandFn rather than swallowing it", async () => {
  const failingUnderstandFn = async () => {
    throw new Error("simulated model failure");
  };
  await assert.rejects(
    () => orchestrate("hi", {}, { understandFn: failingUnderstandFn }),
    /simulated model failure/
  );
});

// Unit tests for the Deterministic Business Router (Sprint-1 Task 1).
// Run with: node --test src/router/route.test.js
// No test framework dependency - uses Node's built-in test runner.

import test from "node:test";
import assert from "node:assert/strict";
import { route } from "./route.js";

// --- T-C4 (critical regression case) ---

test("order_confirm: high confidence + awaiting_confirmation -> FRESH_READ_AND_CONFIRM", () => {
  const decision = route({
    intent: "order_confirm",
    confidence: "high",
    orderState: { stage: "awaiting_confirmation" },
  });
  assert.equal(decision, "FRESH_READ_AND_CONFIRM");
});

test("order_confirm: medium confidence + active order -> FALLBACK_CLARIFY (T-C4)", () => {
  const decision = route({
    intent: "order_confirm",
    confidence: "medium",
    orderState: { stage: "awaiting_confirmation" },
  });
  assert.equal(decision, "FALLBACK_CLARIFY");
});

test("order_confirm: no active order -> FALLBACK_NO_ACTIVE_ORDER", () => {
  const decision = route({ intent: "order_confirm", confidence: "high", orderState: null });
  assert.equal(decision, "FALLBACK_NO_ACTIVE_ORDER");
});

// --- T-INTENT-1 (unrecognized -> unknown, never force-fit) ---

test("unknown / unrecognized intent always -> FALLBACK_UNKNOWN_INTENT", () => {
  assert.equal(route({ intent: "unknown", confidence: "high" }), "FALLBACK_UNKNOWN_INTENT");
  assert.equal(route({ intent: "not_a_real_intent", confidence: "high" }), "FALLBACK_UNKNOWN_INTENT");
  assert.equal(route(), "FALLBACK_UNKNOWN_INTENT");
});

// --- Structural check supporting T-C2: the Router's output is always a
// plain systemDecision string - a fundamentally different, incompatible
// shape from the legacy {action: "..."} object contract. ---

test("route() always returns a plain string, never an action-shaped object", () => {
  assert.equal(typeof route({ intent: "product_inquiry", confidence: "high" }), "string");
  assert.equal(typeof route({ intent: "order_confirm", confidence: "high", orderState: { stage: "awaiting_confirmation" } }), "string");
});

// --- Full table wiring: one spot check per intent ---

test("product_inquiry: high/medium/low", () => {
  assert.equal(route({ intent: "product_inquiry", confidence: "high" }), "LOOKUP_PRODUCT_AND_RESPOND");
  assert.equal(route({ intent: "product_inquiry", confidence: "medium" }), "PRESENT_CANDIDATES");
  assert.equal(route({ intent: "product_inquiry", confidence: "low" }), "FALLBACK_CLARIFY");
});

test("variant_inquiry: high/medium/low", () => {
  assert.equal(route({ intent: "variant_inquiry", confidence: "high" }), "LOOKUP_VARIANT_AND_RESPOND");
  assert.equal(route({ intent: "variant_inquiry", confidence: "medium" }), "PRESENT_CANDIDATES");
  assert.equal(route({ intent: "variant_inquiry", confidence: "low" }), "FALLBACK_CLARIFY");
});

test("delivery_inquiry: wilaya entity present vs absent", () => {
  assert.equal(route({ intent: "delivery_inquiry", entities: { wilaya: "Alger" } }), "LOOKUP_DELIVERY_AND_RESPOND");
  assert.equal(route({ intent: "delivery_inquiry", entities: {} }), "FALLBACK_CLARIFY");
});

test("order_initiate: always -> BEGIN_ORDER_COLLECTION", () => {
  assert.equal(route({ intent: "order_initiate" }), "BEGIN_ORDER_COLLECTION");
});

test("order_info_provide: active vs no active order", () => {
  assert.equal(route({ intent: "order_info_provide", orderState: { stage: "collecting_info" } }), "UPDATE_ORDER_INFO");
  assert.equal(route({ intent: "order_info_provide", orderState: null }), "FALLBACK_NO_ACTIVE_ORDER");
});

test("order_modify: non-variant field vs variant field by confidence", () => {
  assert.equal(route({ intent: "order_modify", entities: { modifiedField: "wilaya" } }), "VALIDATE_AND_UPDATE_ORDER_FIELD");
  assert.equal(route({ intent: "order_modify", entities: { modifiedField: "color" }, confidence: "high" }), "VALIDATE_AND_UPDATE_ORDER_FIELD");
  assert.equal(route({ intent: "order_modify", entities: { modifiedField: "color" }, confidence: "medium" }), "PRESENT_CANDIDATES");
  assert.equal(route({ intent: "order_modify", entities: { modifiedField: "size" }, confidence: "low" }), "FALLBACK_CLARIFY");
});

test("order_cancel: created -> handoff, earlier stages -> cancel, no order -> fallback", () => {
  assert.equal(route({ intent: "order_cancel", orderState: { stage: "created" } }), "HANDOFF_TO_HUMAN");
  assert.equal(route({ intent: "order_cancel", orderState: { stage: "collecting_info" } }), "CANCEL_ORDER");
  assert.equal(route({ intent: "order_cancel", orderState: { stage: "awaiting_confirmation" } }), "CANCEL_ORDER");
  assert.equal(route({ intent: "order_cancel", orderState: { stage: "confirmed" } }), "CANCEL_ORDER");
  assert.equal(route({ intent: "order_cancel", orderState: null }), "FALLBACK_NO_ACTIVE_ORDER");
});

test("general_question, complaint, greeting: fixed decisions", () => {
  assert.equal(route({ intent: "general_question" }), "LOOKUP_POLICY_AND_RESPOND");
  assert.equal(route({ intent: "complaint" }), "HANDOFF_TO_HUMAN");
  assert.equal(route({ intent: "greeting" }), "GREET_RESPOND");
});

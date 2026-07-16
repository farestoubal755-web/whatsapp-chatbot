// Contract tests for the Deterministic Business Router (Sprint-1 Task 4).
// Run with: node --test src/router/route.contract.test.js
//
// Kept as a separate file rather than extending route.test.js (Task 1,
// already approved), per Task 4 scope decision. This file proves two
// contract guarantees DASP-005 T-C2 and T-INTENT-1 require at the Router
// level only:
//
// 1. The Router never reads or is influenced by an `action`-like field,
//    even if one is present on the input object - its signature only ever
//    destructures {intent, entities, confidence, orderState}. This is the
//    structural half of T-C2 (nothing the AI layer emits can make the
//    Router fall back to a legacy-style shortcut, because the Router has
//    no code path that inspects such a field at all).
// 2. Unknown or unrecognized intents always resolve to
//    FALLBACK_UNKNOWN_INTENT, never a force-fit guess. This is the Router
//    half of T-INTENT-1.
//
// NEITHER test here proves anything about the AI Understanding Layer's
// actual classification judgment (i.e. whether understand() itself would
// correctly call a genuinely ambiguous message "unknown"). That requires
// either a live model call (out of scope) or a mocked-response test at
// the src/ai.js level, tracked as a separate, still-pending piece of
// Task 4 pending a Node compatibility check.

import test from "node:test";
import assert from "node:assert/strict";
import { route } from "./route.js";

test("T-C2 (Router-level): an action-like field on the input is silently ignored", () => {
  const withoutAction = route({ intent: "product_inquiry", confidence: "high" });
  const withAction = route({ intent: "product_inquiry", confidence: "high", action: "search_products" });
  assert.equal(withAction, withoutAction);
  assert.equal(withAction, "LOOKUP_PRODUCT_AND_RESPOND");
});

test("T-C2 (Router-level): an action-like field cannot override a low-confidence fallback", () => {
  const withoutAction = route({ intent: "product_inquiry", confidence: "low" });
  const withAction = route({ intent: "product_inquiry", confidence: "low", action: "search_products" });
  assert.equal(withAction, withoutAction);
  assert.equal(withAction, "FALLBACK_CLARIFY");
});

test('T-INTENT-1 (Router-level): intent "unknown" always resolves to FALLBACK_UNKNOWN_INTENT', () => {
  assert.equal(route({ intent: "unknown", confidence: "high" }), "FALLBACK_UNKNOWN_INTENT");
});

test("T-INTENT-1 (Router-level): an unrecognized intent string is never force-fit to a known intent", () => {
  assert.equal(route({ intent: "totally_made_up_intent", confidence: "high" }), "FALLBACK_UNKNOWN_INTENT");
  assert.equal(route({ intent: "", confidence: "high" }), "FALLBACK_UNKNOWN_INTENT");
  assert.equal(route({}), "FALLBACK_UNKNOWN_INTENT");
});

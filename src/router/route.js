// The Deterministic Business Router (DASP-004 SS4.2, DASP-002 Rule 003).
//
// Pure function: no AI/model call, no Sheets access, no I/O of any kind.
// Given the AI Understanding Layer's {intent, entities, confidence} plus
// the current Order State, it returns exactly one systemDecision string,
// derived solely from DECISION_TABLE. It contains no business logic itself
// - every decision traces back to a table row in decisionTable.js.
//
// NOTE: `orderState` is a 4th input beyond the {intent, entities, confidence}
// contract literally described in DASP-004 SS4.1. This is necessary because
// several approved table rows (order_confirm, order_cancel,
// order_info_provide) require current Order State to evaluate, per
// DASP-004 SS4.2's own example ("+ Order State at confirm stage"). Flagged
// in the Task 1 report as a DASP-004 documentation gap, not a business
// decision.

import { DECISION_TABLE, UNKNOWN_INTENT_DECISION } from "./decisionTable.js";

function buildContext({ entities = {}, confidence, orderState }) {
  const hasActiveOrder = Boolean(orderState) && orderState.stage !== "none";
  return {
    confidence,
    hasWilaya: Boolean(entities.wilaya),
    hasActiveOrder,
    stage: orderState ? orderState.stage : "none",
    modifiedField: entities.modifiedField,
  };
}

export function route({ intent, entities, confidence, orderState } = {}) {
  const rules = DECISION_TABLE[intent];
  if (!rules) return UNKNOWN_INTENT_DECISION;

  const ctx = buildContext({ entities, confidence, orderState });
  const rule = rules.find((r) => r.when(ctx));
  return rule ? rule.decision : UNKNOWN_INTENT_DECISION;
}

// Legacy Action Adapter (DASP-004 SS4.3 Phase 1, Sprint-1 Task 3).
//
// Pure function: translates a systemDecision (produced by src/router/route.js)
// into the closest existing legacy `action` value, so the current
// action-based handlers (reply / search_products / confirm_order / handoff)
// keep working unmodified. This is the sole translation point (T-MIG-2) -
// nothing else in the codebase is wired to consume systemDecision yet.
//
// IMPORTANT: this mapping keeps the pipeline consistent, but it does not
// make CANCEL_ORDER, UPDATE_ORDER_INFO, or BEGIN_ORDER_COLLECTION
// behaviorally real. The legacy handlers have no equivalent logic for
// them; they simply fall through to the generic "reply" path exactly as
// they do today.

export const LEGACY_ACTION_MAP = {
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

export const DEFAULT_LEGACY_ACTION = "reply";

export function toLegacyAction(systemDecision) {
  return LEGACY_ACTION_MAP[systemDecision] ?? DEFAULT_LEGACY_ACTION;
}

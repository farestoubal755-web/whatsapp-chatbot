// Single, auditable Intent -> systemDecision mapping (DASP-004 SS4.2).
// Source: DASP-004 SS4.2 given rows, DASP-005 T-C4, and the Sprint-1 Task 0
// table (all 12 intents, amendments A-D applied, approved 2026-07-15).
//
// Each intent maps to an ORDERED list of rules. route.js evaluates them
// top-to-bottom and takes the first matching rule. This file is data; it
// contains no business logic beyond the `when` predicates themselves, which
// mirror the approved table's own conditions one-to-one.

const isVariantField = (field) => field === "product" || field === "color" || field === "size";

export const UNKNOWN_INTENT_DECISION = "FALLBACK_UNKNOWN_INTENT";

export const DECISION_TABLE = {
  product_inquiry: [
    { when: (ctx) => ctx.confidence === "high", decision: "LOOKUP_PRODUCT_AND_RESPOND" },
    { when: (ctx) => ctx.confidence === "medium", decision: "PRESENT_CANDIDATES" },
    { when: (ctx) => ctx.confidence === "low", decision: "FALLBACK_CLARIFY" },
  ],

  variant_inquiry: [
    { when: (ctx) => ctx.confidence === "high", decision: "LOOKUP_VARIANT_AND_RESPOND" },
    { when: (ctx) => ctx.confidence === "medium", decision: "PRESENT_CANDIDATES" },
    { when: (ctx) => ctx.confidence === "low", decision: "FALLBACK_CLARIFY" },
  ],

  // Amendment A: binary, no fuzzy/medium tier. NOTE: the Router only knows
  // whether a wilaya entity was extracted - not whether it matches a
  // SHIPPING row. That lookup belongs to the Delivery Engine, which is
  // forbidden/out of scope for this task. See Task 1 report SS3.
  delivery_inquiry: [
    { when: (ctx) => Boolean(ctx.hasWilaya), decision: "LOOKUP_DELIVERY_AND_RESPOND" },
    { when: () => true, decision: "FALLBACK_CLARIFY" },
  ],

  // Amendment B: binary, no confidence tiers.
  order_initiate: [
    { when: () => true, decision: "BEGIN_ORDER_COLLECTION" },
  ],

  order_info_provide: [
    { when: (ctx) => ctx.hasActiveOrder, decision: "UPDATE_ORDER_INFO" },
    { when: () => true, decision: "FALLBACK_NO_ACTIVE_ORDER" },
  ],

  // Resolves the T-C4 gap explicitly (third rule).
  order_confirm: [
    { when: (ctx) => !ctx.hasActiveOrder, decision: "FALLBACK_NO_ACTIVE_ORDER" },
    { when: (ctx) => ctx.confidence === "high" && ctx.stage === "awaiting_confirmation", decision: "FRESH_READ_AND_CONFIRM" },
    { when: () => true, decision: "FALLBACK_CLARIFY" },
  ],

  // Amendment C: variant-field edits reuse the product/variant pipeline;
  // non-variant fields are a direct validated update.
  order_modify: [
    { when: (ctx) => !isVariantField(ctx.modifiedField), decision: "VALIDATE_AND_UPDATE_ORDER_FIELD" },
    { when: (ctx) => ctx.confidence === "high", decision: "VALIDATE_AND_UPDATE_ORDER_FIELD" },
    { when: (ctx) => ctx.confidence === "medium", decision: "PRESENT_CANDIDATES" },
    { when: () => true, decision: "FALLBACK_CLARIFY" },
  ],

  // Amendment D. No new stage value; HANDOFF_TO_HUMAN reuses the same path
  // as `complaint` (existing notifyAdmin()/ADMIN_PHONE - no new mechanism).
  order_cancel: [
    { when: (ctx) => !ctx.hasActiveOrder, decision: "FALLBACK_NO_ACTIVE_ORDER" },
    { when: (ctx) => ctx.stage === "created", decision: "HANDOFF_TO_HUMAN" },
    { when: () => true, decision: "CANCEL_ORDER" },
  ],

  // Whether an active policy_key exists is the Policy Engine's own
  // responsibility (DASP-004 SS6.4) - same clarification as delivery_inquiry.
  general_question: [
    { when: () => true, decision: "LOOKUP_POLICY_AND_RESPOND" },
  ],

  complaint: [
    { when: () => true, decision: "HANDOFF_TO_HUMAN" },
  ],

  greeting: [
    { when: () => true, decision: "GREET_RESPOND" },
  ],

  unknown: [
    { when: () => true, decision: UNKNOWN_INTENT_DECISION },
  ],
};

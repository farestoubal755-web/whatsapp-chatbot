// Orchestration Layer (Sprint 2).
//
// Pure composition of understand() -> route() -> toLegacyAction(), with NO
// live-capable default anywhere. `understandFn` must be injected
// explicitly; this file does not import src/ai.js at all, so it has no
// way to make a real model call even by accident.
//
// This is standalone, unwired code - nothing in server.js calls this.

import { route } from "../router/route.js";
import { toLegacyAction } from "../router/legacyAdapter.js";

export async function orchestrate(message, context = {}, deps = {}) {
  const { understandFn } = deps;
  if (typeof understandFn !== "function") {
    throw new Error("orchestrate() requires an injected understandFn - no default implementation exists.");
  }

  const { orderState = null, understandingContext = {} } = context;

  const understanding = await understandFn(message, understandingContext);

  const systemDecision = route({
    intent: understanding.intent,
    entities: understanding.entities,
    confidence: understanding.confidence,
    orderState,
  });

  const legacyAction = toLegacyAction(systemDecision);

  return {
    intent: understanding.intent,
    entities: understanding.entities,
    confidence: understanding.confidence,
    systemDecision,
    legacyAction,
  };
}

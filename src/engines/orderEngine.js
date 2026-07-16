// Order Engine - Fresh Read foundation (Sprint 3 Task 0).
//
// Order Engine introduces no cache of its own. Every Sheets read goes
// through freshReadRows(), which always requests { ttlMs: 0 } from its
// injected getValuesFn. Per static inspection of the existing, unmodified
// sheetsClient.js: ttlMs: 0 causes getValues() to skip its own cache-read
// AND cache-write logic entirely, always performing a real call to the
// Sheets API. That is a property of the existing module, confirmed by
// reading its source - it is not, and cannot be, proven by the unit tests
// in this file, since those tests never call the real getValues() at all.
// See orderEngine.test.js and the Sprint 3 Task 0 report for the precise
// distinction between what is confirmed by static inspection and what is
// proven by executed tests.
//
// The row-mapping algorithm here (header selection, normalize()-based
// key mapping, empty-row filtering) is deliberately identical to
// store.js's existing readAliasedRows()/mapAliasedRow(), verified by
// direct comparison against that code - not assumed. This function does
// not import from store.js; it reuses only src/utils.js's normalize(),
// which store.js also uses.
//
// This mirrors store.js's pattern rather than reusing store.js directly,
// because store.js's equivalent functions carry a 20-second TTL cache
// that would violate the Fresh Read guarantee Order Engine's future
// confirmation logic (Phase C) depends on (DASP-002 Rule 004). See the
// Sprint 3 Design Note (Option C selected); migration to a shared,
// Rule-005-compliant read path is expected once Product Engine exists.
//
// No default, network-capable dependency: getValuesFn must be injected.
// This is standalone, unwired code - nothing in server.js calls this.

import { normalize, pick, toNumber } from "../utils.js";

// Google Sheets A1 notation escapes an embedded apostrophe in a quoted
// sheet name by doubling it. This is the only character that needs
// escaping inside a quoted sheet name. Note: the existing, unmodified
// store.js/sheetsClient.js do not perform this escaping anywhere today -
// this is new behavior introduced here, not a claim that store.js has
// been fixed.
function escapeSheetName(tab) {
  return tab.replace(/'/g, "''");
}

function buildRange(tab) {
  return `'${escapeSheetName(tab)}'!A:ZZ`;
}

function mapAliasedRow(headers, row) {
  return Object.fromEntries(headers.map((h, i) => [normalize(h), row[i] ?? ""]));
}

export async function freshReadRows(tab, deps = {}) {
  if (typeof tab !== "string" || tab.length === 0) {
    throw new Error("freshReadRows() requires a non-empty tab name");
  }

  const { getValuesFn } = deps;
  if (typeof getValuesFn !== "function") {
    throw new Error("freshReadRows() requires an injected getValuesFn - no default implementation exists.");
  }

  const range = buildRange(tab);
  const values = await getValuesFn(range, { ttlMs: 0 });

  if (values.length < 2) return [];

  return values
    .slice(1)
    .filter((row) => row.some((cell) => String(cell).trim()))
    .map((row) => mapAliasedRow(values[0], row));
}

// Order Stage state machine (Sprint 3 Task 1).
//
// Pure, synchronous, dependency-free. Operates only on the `stage` field
// of an OrderState object (e.g. `orderState.stage`, as already consumed
// by src/router/route.js) - not on the full OrderState object itself.
// No other OrderState field (customer info, product, pricing, etc.) is
// defined or validated here.
//
// Transitions are forward-only and strictly linear, with self-transitions
// (same stage -> same stage) explicitly legal as a no-op: a customer can
// send multiple messages while remaining in the same conversational
// stage, and that must not be treated as a caller bug. No backward
// transition is ever legal. Cancellation (any transition to a
// "cancelled" state) is explicitly out of scope for this task - there is
// no such stage in ORDER_STAGES.
//
// ORDER_STAGES is the single source of truth: order matters (index =
// position in the linear sequence), and every function below - plus this
// file's test suite - derives from it rather than repeating stage names.

export const ORDER_STAGES = Object.freeze([
  "none",
  "collecting_info",
  "awaiting_confirmation",
  "confirmed",
  "created",
]);

export function isValidOrderStage(value) {
  return ORDER_STAGES.includes(value);
}

export function canTransitionOrderStage(fromStage, toStage) {
  if (!isValidOrderStage(fromStage)) {
    throw new Error(
      `canTransitionOrderStage(): '${fromStage}' is not a valid order stage - must be one of: ${ORDER_STAGES.join(", ")}`
    );
  }
  if (!isValidOrderStage(toStage)) {
    throw new Error(
      `canTransitionOrderStage(): '${toStage}' is not a valid order stage - must be one of: ${ORDER_STAGES.join(", ")}`
    );
  }

  const delta = ORDER_STAGES.indexOf(toStage) - ORDER_STAGES.indexOf(fromStage);
  return delta === 0 || delta === 1;
}

export function transitionOrderStage(fromStage, toStage) {
  if (!canTransitionOrderStage(fromStage, toStage)) {
    throw new Error(
      `transitionOrderStage(): cannot move from '${fromStage}' to '${toStage}' - only the same stage or the next stage in the sequence is a legal transition`
    );
  }
  return toStage;
}

// Grounded Confirmation (Sprint 3 Task 2).
//
// confirmGroundedOrder() revalidates price, variant, and delivery cost via a
// mandatory Fresh Read before an order may be confirmed (DASP-002 Rule 004;
// DASP-001 §2.6 Exception; DASP-004 §6.3). It receives an already
// product-matched, already Confidence-resolved OrderState from the
// Router/Product Engine - it performs no matching, search, or Confidence
// computation of its own (Sprint-3-Brief.md Scope). PRODUCTS 1 is read
// directly via freshReadRows(); delivery cost is obtained only through the
// injected getFreshDeliveryQuote() boundary - this function never implements
// or imports Delivery Engine logic (Sprint-3-Brief.md Forbidden Files).
//
// It returns a deterministic ConfirmationResult and, where applicable, a
// proposed OrderState patch. It never persists state, never generates
// customer-facing text, and never refreshes lastConfirmedPriceShownAt -
// those are Orchestrator/reply-layer responsibilities.
//
// Price cells accept only: plain digits; a comma with 1-2 trailing digits
// (decimal); a single comma-thousands group with exactly 3 trailing digits;
// or a dot with 1-2 trailing digits (decimal). A dot with 3+ trailing digits
// (e.g. "1.200") is deliberately rejected before toNumber() is ever called on
// it: toNumber() has no disambiguation branch for a lone dot and would parse
// "1.200" as 1.2 (DASP-005 T-C3's still-open finding) - this is contained by
// validation here, not fixed in utils.js, which this file does not modify.

function isWellFormedPriceCell(rawValue) {
  const s = String(rawValue ?? "").trim();
  if (s === "") return false;
  if (/^\d+$/.test(s)) return true;
  if (/^\d+,\d{1,2}$/.test(s)) return true;
  if (/^\d+,\d{3}$/.test(s)) return true;
  if (/^\d+\.\d{1,2}$/.test(s)) return true;
  return false;
}

function isWellFormedStockCell(rawValue) {
  const s = String(rawValue ?? "").trim();
  return s !== "" && /^\d+$/.test(s);
}

function parseRequiredPrice(rawValue) {
  if (!isWellFormedPriceCell(rawValue)) return { valid: false };
  const n = toNumber(rawValue);
  if (!Number.isFinite(n) || n < 0) return { valid: false };
  return { valid: true, value: n };
}

function parseRequiredStock(rawValue) {
  if (!isWellFormedStockCell(rawValue)) return { valid: false };
  const n = toNumber(rawValue);
  if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) return { valid: false };
  return { valid: true, value: n };
}

function isValidStoredNumber(n) {
  return typeof n === "number" && Number.isFinite(n) && n >= 0;
}

function assertConfirmGroundedOrderPreconditions(orderState, deps) {
  if (orderState === null || typeof orderState !== "object") {
    throw new TypeError("confirmGroundedOrder(): orderState must be a non-null object");
  }
  if (!isValidOrderStage(orderState.stage)) {
    throw new RangeError("confirmGroundedOrder(): orderState.stage is not a valid order stage");
  }
  if (orderState.stage !== "awaiting_confirmation") {
    throw new RangeError("confirmGroundedOrder(): orderState.stage must be 'awaiting_confirmation'");
  }
  if (typeof orderState.validatedProductId !== "string") {
    throw new TypeError("confirmGroundedOrder(): validatedProductId must be a string");
  }
  if (orderState.validatedProductId.trim().length === 0) {
    throw new RangeError(
      "confirmGroundedOrder(): validatedProductId must be non-empty (whitespace-only is treated as empty)"
    );
  }
  if (orderState.validatedVariant === null || typeof orderState.validatedVariant !== "object") {
    throw new TypeError("confirmGroundedOrder(): validatedVariant must be a non-null object");
  }
  if (typeof orderState.validatedVariant.color !== "string") {
    throw new TypeError("confirmGroundedOrder(): validatedVariant.color must be a string");
  }
  if (orderState.validatedVariant.color.trim().length === 0) {
    throw new RangeError(
      "confirmGroundedOrder(): validatedVariant.color must be non-empty (whitespace-only is treated as empty)"
    );
  }
  if (typeof orderState.validatedVariant.size !== "string") {
    throw new TypeError("confirmGroundedOrder(): validatedVariant.size must be a string");
  }
  if (orderState.validatedVariant.size.trim().length === 0) {
    throw new RangeError(
      "confirmGroundedOrder(): validatedVariant.size must be non-empty (whitespace-only is treated as empty)"
    );
  }
  if (typeof orderState.wilaya !== "string") {
    throw new TypeError("confirmGroundedOrder(): wilaya must be a string");
  }
  if (orderState.wilaya.trim().length === 0) {
    throw new RangeError("confirmGroundedOrder(): wilaya must be non-empty (whitespace-only is treated as empty)");
  }
  if (typeof orderState.commune !== "string") {
    throw new TypeError("confirmGroundedOrder(): commune must be a string");
  }
  if (orderState.commune.trim().length === 0) {
    throw new RangeError("confirmGroundedOrder(): commune must be non-empty (whitespace-only is treated as empty)");
  }
  if (typeof orderState.deliveryType !== "string") {
    throw new TypeError("confirmGroundedOrder(): deliveryType must be a string");
  }
  if (orderState.deliveryType !== "home" && orderState.deliveryType !== "office") {
    throw new RangeError("confirmGroundedOrder(): deliveryType must be 'home' or 'office'");
  }
  if (deps === null || typeof deps !== "object") {
    throw new TypeError("confirmGroundedOrder(): deps must be a non-null object");
  }
  if (typeof deps.getValuesFn !== "function") {
    throw new TypeError("confirmGroundedOrder(): deps.getValuesFn must be a function");
  }
  if (typeof deps.getFreshDeliveryQuote !== "function") {
    throw new TypeError("confirmGroundedOrder(): deps.getFreshDeliveryQuote must be a function");
  }
}

function findCanonicalProductRow(productRows, orderState) {
  const wantedProduct = normalize(orderState.validatedProductId);
  const wantedColor = normalize(orderState.validatedVariant.color);
  const wantedSize = normalize(orderState.validatedVariant.size);
  return productRows.find(
    (row) =>
      normalize(pick(row, "product")) === wantedProduct &&
      normalize(pick(row, "color")) === wantedColor &&
      normalize(pick(row, "size")) === wantedSize
  );
}

export async function confirmGroundedOrder(orderState, deps = {}) {
  assertConfirmGroundedOrderPreconditions(orderState, deps);

  const { getValuesFn, getFreshDeliveryQuote } = deps;
  const productsPromise = freshReadRows("PRODUCTS 1", { getValuesFn });
  const deliveryPromise = getFreshDeliveryQuote(orderState.wilaya, orderState.commune, orderState.deliveryType);
  const [productRows, deliveryQuote] = await Promise.all([productsPromise, deliveryPromise]);

  const row = findCanonicalProductRow(productRows, orderState);
  if (!row) {
    return { status: "variant_unavailable", patch: {} };
  }

  const stock = parseRequiredStock(pick(row, "stock"));
  if (stock.valid && stock.value === 0) {
    return { status: "out_of_stock", patch: {} };
  }

  const price = parseRequiredPrice(pick(row, "price"));
  if (!price.valid) {
    return { status: "grounding_failure", patch: {}, reason: "product_price" };
  }

  if (!stock.valid) {
    return { status: "grounding_failure", patch: {}, reason: "product_stock" };
  }

  if (!isValidStoredNumber(orderState.productPrice)) {
    return { status: "grounding_failure", patch: {}, reason: "stored_price" };
  }

  if (!isValidStoredNumber(orderState.deliveryPrice)) {
    return { status: "grounding_failure", patch: {}, reason: "stored_delivery_price" };
  }

  if (deliveryQuote === null || typeof deliveryQuote !== "object" || Array.isArray(deliveryQuote)) {
    return { status: "grounding_failure", patch: {}, reason: "delivery_read_shape" };
  }
  if (typeof deliveryQuote.matched !== "boolean") {
    return { status: "grounding_failure", patch: {}, reason: "delivery_read_shape" };
  }

  const deliveryValid =
    deliveryQuote.matched &&
    typeof deliveryQuote.price === "number" &&
    Number.isFinite(deliveryQuote.price) &&
    deliveryQuote.price >= 0;
  if (!deliveryValid) {
    return { status: "grounding_failure", patch: {}, reason: "delivery" };
  }

  const changedFields = [];
  if (price.value !== orderState.productPrice) changedFields.push("price");
  if (deliveryQuote.price !== orderState.deliveryPrice) changedFields.push("deliveryPrice");

  if (changedFields.length > 0) {
    return {
      status: "facts_changed",
      patch: {},
      changedFields,
      freshValues: { price: price.value, deliveryPrice: deliveryQuote.price },
      previousValues: { price: orderState.productPrice, deliveryPrice: orderState.deliveryPrice },
    };
  }

  return {
    status: "confirmed",
    patch: { stage: transitionOrderStage("awaiting_confirmation", "confirmed") },
    freshValues: { price: price.value, deliveryPrice: deliveryQuote.price },
  };
}

// Idempotent Order Creation (Sprint 3 Task 3).
//
// createIdempotentOrder() is a contract implementation only: it defines and
// calls an injected atomic idempotency boundary (deps.createOrderRecord),
// keyed by the inbound WhatsApp message ID (DASP-002 Rule 022; DASP-004
// §6.3, §7, §9). It does not implement a real, durable Google Sheets/store
// adapter - the current store.js createOrder() and ORDERS schema do not
// satisfy this contract (no message-ID column, no check-before-write).
//
// This function's unit tests prove Order Engine contract behavior only:
// that it always calls createOrderRecord, on every structurally valid
// attempt (including when local stage is already "created"), never
// bypasses it, never retries internally, and correctly maps its resolved
// response to a CreationResult. They do not prove production/durable
// idempotency. Real wiring must not be approved for team testing or
// deployment until a persistence implementation provides durable atomic
// check-and-create keyed by the inbound WhatsApp message ID.
//
// createOrderRecord owns the atomic created/already_created/conflict
// decision entirely - this function never independently compares a
// returned record after the fact and calls that atomic. It keeps no local
// duplicate cache or Set of its own; local orderState.stage is used only
// to reject clearly premature calls, never as a substitute for the durable
// check (DASP-004 §9 - every attempt, including retries, must re-verify).
//
// idempotencyKey is a separate parameter, not an OrderState field
// (DASP-004 §5.2 has no such field); it is never normalized or mutated -
// it is a platform-assigned opaque identifier, not DASP-001 Business Data.
//
// orderCreationStatus is not part of this function's input contract (never
// read) - only stage gates entry. It still appears as a declarative value
// in the proposed patch, which does not require having read the prior
// value.

function assertCreateIdempotentOrderPreconditions(orderState, idempotencyKey, deps) {
  if (orderState === null || typeof orderState !== "object") {
    throw new TypeError("createIdempotentOrder(): orderState must be a non-null object");
  }
  if (!isValidOrderStage(orderState.stage)) {
    throw new RangeError("createIdempotentOrder(): orderState.stage is not a valid order stage");
  }
  if (orderState.stage !== "confirmed" && orderState.stage !== "created") {
    throw new RangeError("createIdempotentOrder(): orderState.stage must be 'confirmed' or 'created'");
  }
  if (typeof idempotencyKey !== "string") {
    throw new TypeError("createIdempotentOrder(): idempotencyKey must be a string");
  }
  if (idempotencyKey.trim().length === 0) {
    throw new RangeError(
      "createIdempotentOrder(): idempotencyKey must be non-empty (whitespace-only is treated as empty)"
    );
  }
  if (deps === null || typeof deps !== "object") {
    throw new TypeError("createIdempotentOrder(): deps must be a non-null object");
  }
  if (typeof deps.createOrderRecord !== "function") {
    throw new TypeError("createIdempotentOrder(): deps.createOrderRecord must be a function");
  }
  if (!isValidStoredNumber(orderState.productPrice)) {
    throw new RangeError("createIdempotentOrder(): orderState.productPrice must be a finite, non-negative number");
  }
  if (!isValidStoredNumber(orderState.deliveryPrice)) {
    throw new RangeError("createIdempotentOrder(): orderState.deliveryPrice must be a finite, non-negative number");
  }
  if (!isValidStoredNumber(orderState.totalPrice)) {
    throw new RangeError("createIdempotentOrder(): orderState.totalPrice must be a finite, non-negative number");
  }
}

function buildOrderPayload(orderState) {
  return {
    customerName: orderState.customerName,
    phone: orderState.phone,
    wilaya: orderState.wilaya,
    commune: orderState.commune,
    deliveryType: orderState.deliveryType,
    validatedProductId: orderState.validatedProductId,
    validatedVariant: orderState.validatedVariant,
    productPrice: orderState.productPrice,
    deliveryPrice: orderState.deliveryPrice,
    totalPrice: orderState.totalPrice,
  };
}

function isPlainObjectLike(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export async function createIdempotentOrder(orderState, idempotencyKey, deps = {}) {
  assertCreateIdempotentOrderPreconditions(orderState, idempotencyKey, deps);

  const { createOrderRecord } = deps;
  const payload = buildOrderPayload(orderState);
  const result = await createOrderRecord(idempotencyKey, payload);

  if (!isPlainObjectLike(result)) {
    return { status: "persistence_read_shape", patch: {} };
  }
  if (result.outcome !== "created" && result.outcome !== "already_created" && result.outcome !== "conflict") {
    return { status: "persistence_read_shape", patch: {} };
  }
  if ((result.outcome === "created" || result.outcome === "already_created") && !isPlainObjectLike(result.order)) {
    return { status: "persistence_read_shape", patch: {} };
  }
  if (result.outcome === "conflict") {
    if (!Array.isArray(result.conflictingFields)) {
      return { status: "persistence_read_shape", patch: {} };
    }
    if (result.order !== undefined && !isPlainObjectLike(result.order)) {
      return { status: "persistence_read_shape", patch: {} };
    }
    return { status: "idempotency_conflict", patch: {}, conflictingFields: result.conflictingFields };
  }

  return {
    status: result.outcome === "created" ? "created" : "already_created",
    patch: { stage: transitionOrderStage(orderState.stage, "created"), orderCreationStatus: "created" },
    order: result.order,
  };
}

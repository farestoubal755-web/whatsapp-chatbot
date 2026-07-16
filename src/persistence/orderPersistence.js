// Implements Order Engine's createOrderRecord(idempotencyKey, payload)
// contract (src/engines/orderEngine.js Task 3) with Postgres as the sole
// atomicity boundary. A successful INSERT (or its unique-constraint
// conflict) is the entire durability/idempotency decision - Google Sheets
// projection (projectionReconciler.js) never participates in it and never
// gates this function's return value.
//
// Not wired into orderEngine.js, server.js, or any production path.

import { createHash } from "node:crypto";
import { projectOrderRow, markProjectionFailed } from "./projectionReconciler.js";

const CENT_EPSILON = 1e-6;

// Prices reaching this adapter are already constrained to at most 2 decimal
// places by Order Engine's own Grounded Confirmation validation
// (isWellFormedPriceCell, src/engines/orderEngine.js), so *100 is a
// lossless conversion to integer minor units, not a rounding/tolerance
// operation. The epsilon here exists only to absorb floating-point
// representation noise from upstream arithmetic (~1e-10 to 1e-13 for
// values in this range) - it is ~1e6 tighter than one minor unit and can
// never collapse two genuinely different prices. A value that fails this
// check indicates an upstream contract violation and is rejected, not
// silently rounded.
export function toMinorUnits(value, fieldName) {
  const minor = value * 100;
  const rounded = Math.round(minor);
  if (Math.abs(minor - rounded) >= CENT_EPSILON) {
    throw new RangeError(
      `toMinorUnits(): ${fieldName} (${value}) is not representable as an exact 2-decimal amount`
    );
  }
  return rounded;
}

// Fixed key order, independent of the input payload's own key order, so
// identical logical payloads always serialize identically. Text/identifier
// fields are copied verbatim - never normalize()'d - so a real difference
// in customer-entered data is never silently hidden behind a matching
// fingerprint. This is the single canonical representation used for
// fingerprinting, payload_json storage, and conflictingFields comparison -
// there is no separate "raw" value stored anywhere else.
export function buildCanonicalPayload(payload) {
  return {
    customerName: payload.customerName,
    phone: payload.phone,
    wilaya: payload.wilaya,
    commune: payload.commune,
    deliveryType: payload.deliveryType,
    validatedProductId: payload.validatedProductId,
    validatedVariantColor: payload.validatedVariant.color,
    validatedVariantSize: payload.validatedVariant.size,
    productPriceMinor: toMinorUnits(payload.productPrice, "productPrice"),
    deliveryPriceMinor: toMinorUnits(payload.deliveryPrice, "deliveryPrice"),
    totalPriceMinor: toMinorUnits(payload.totalPrice, "totalPrice"),
  };
}

const CANONICAL_FIELD_ORDER = [
  "customerName", "phone", "wilaya", "commune", "deliveryType",
  "validatedProductId", "validatedVariantColor", "validatedVariantSize",
  "productPriceMinor", "deliveryPriceMinor", "totalPriceMinor",
];

const CONFLICT_FIELD_NAMES = {
  customerName: "customerName",
  phone: "phone",
  wilaya: "wilaya",
  commune: "commune",
  deliveryType: "deliveryType",
  validatedProductId: "validatedProductId",
  validatedVariantColor: "validatedVariant.color",
  validatedVariantSize: "validatedVariant.size",
  productPriceMinor: "productPrice",
  deliveryPriceMinor: "deliveryPrice",
  totalPriceMinor: "totalPrice",
};

function canonicalStringify(canonicalPayload) {
  return JSON.stringify(CANONICAL_FIELD_ORDER.map((key) => canonicalPayload[key]));
}

export function computeFingerprint(canonicalPayload) {
  return createHash("sha256").update(canonicalStringify(canonicalPayload)).digest("hex");
}

// Deterministic on idempotencyKey alone (no DB round-trip, no randomness),
// so two independent computations for the same key always converge before
// either has seen the other. 24 hex chars = 96 bits of entropy; the real
// atomicity/duplicate-prevention guarantee is idempotency_key UNIQUE, not
// this ID's uniqueness - order_id UNIQUE is defense-in-depth only.
export function computeOrderId(idempotencyKey) {
  const digest = createHash("sha256").update(idempotencyKey).digest("hex");
  return `DL-${digest.slice(0, 24)}`;
}

// Compares preserved raw (canonical, unnormalized) values on both sides -
// never the fingerprint or any rounded/normalized substitute - so a
// reported conflict always reflects a real business-data difference.
export function diffConflictingFields(existingCanonicalPayload, newCanonicalPayload) {
  const fields = [];
  for (const key of CANONICAL_FIELD_ORDER) {
    if (existingCanonicalPayload[key] !== newCanonicalPayload[key]) {
      fields.push(CONFLICT_FIELD_NAMES[key]);
    }
  }
  return fields;
}

export function toOrderView(row) {
  return {
    id: row.order_id,
    total: row.payload_json.totalPriceMinor / 100,
    createdAt: row.created_at,
  };
}

const INSERT_SQL = `
  INSERT INTO orders (idempotency_key, payload_fingerprint, order_id, payload_json)
  VALUES ($1, $2, $3, $4)
  ON CONFLICT (idempotency_key) DO NOTHING
  RETURNING *
`;

const SELECT_BY_KEY_SQL = `SELECT * FROM orders WHERE idempotency_key = $1`;

// deps: { pool, getValuesFn, appendValuesFn, ordersTab, logger }. pool must
// expose query() (a node-postgres Pool or equivalent fake); the Sheets deps
// are only used by the inline projection attempt below, never by the
// INSERT/SELECT decision itself.
export function createOrderPersistence(deps) {
  const { pool, logger = console } = deps;
  if (!pool || typeof pool.query !== "function") {
    throw new TypeError("createOrderPersistence(): deps.pool must expose query()");
  }

  async function createOrderRecord(idempotencyKey, payload) {
    const canonicalPayload = buildCanonicalPayload(payload);
    const fingerprint = computeFingerprint(canonicalPayload);
    const orderId = computeOrderId(idempotencyKey);

    const inserted = await pool.query(INSERT_SQL, [idempotencyKey, fingerprint, orderId, canonicalPayload]);

    if (inserted.rowCount === 1) {
      const row = inserted.rows[0];
      // Fire-and-forget: a latency optimization only. The row is already
      // durably 'pending' at this point - projectionReconciler.js's sweep
      // owns eventual delivery to Sheets regardless of what happens to this
      // in-flight attempt (safe to abandon on response completion, process
      // restart, or redeploy). If the attempt does settle with a rejection,
      // mark it 'failed' via the same helper the sweep uses, so a stuck
      // Sheets outage is visible/retry-eligible immediately rather than
      // silently sitting as 'pending' until the next sweep pass. The inner
      // try/catch is deliberate: a failure to persist that status update
      // must never surface as an unhandled rejection, retry, or second
      // Sheets append - it is only ever logged as a separate operational
      // error.
      projectOrderRow(row, deps).catch(async (err) => {
        logger.warn(`[orderPersistence] inline projection failed for ${row.order_id}: ${err.message}`);
        try {
          await markProjectionFailed(row, err, deps);
        } catch (markErr) {
          logger.error(
            `[orderPersistence] failed to persist projection-failure status for ${row.order_id}: ${markErr.message}`
          );
        }
      });
      return { outcome: "created", order: toOrderView(row) };
    }

    const existing = await pool.query(SELECT_BY_KEY_SQL, [idempotencyKey]);
    const row = existing.rows[0];

    if (row.payload_fingerprint === fingerprint) {
      return { outcome: "already_created", order: toOrderView(row) };
    }

    return {
      outcome: "conflict",
      conflictingFields: diffConflictingFields(row.payload_json, canonicalPayload),
      order: toOrderView(row),
    };
  }

  return { createOrderRecord };
}

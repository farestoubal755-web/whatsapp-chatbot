// Tests for the Postgres-authoritative order persistence adapter
// (Sprint 3 Task 3 persistence-adapter planning).
// Run with: node --test src/persistence/orderPersistence.test.js
//
// No live Postgres or Google Sheets call anywhere in this file - pool,
// getValuesFn, and appendValuesFn are always fakes, injected via deps.
// These tests prove this adapter's own logic (canonicalization,
// fingerprinting, outcome mapping, fire-and-forget inline projection);
// they do not, and cannot, prove real Postgres atomicity under concurrency
// - that requires a real-Postgres integration test against an actual
// UNIQUE constraint, which is out of scope for this stage (no
// DATABASE_URL has been requested or set).

import test from "node:test";
import assert from "node:assert/strict";
import { ORDER_HEADERS } from "./orderSheetSchema.js";
import {
  createOrderPersistence,
  toMinorUnits,
  buildCanonicalPayload,
  computeFingerprint,
  computeOrderId,
  diffConflictingFields,
  toOrderView,
} from "./orderPersistence.js";

function basePayload(overrides = {}) {
  return {
    customerName: "Amina",
    phone: "0555000000",
    wilaya: "Alger",
    commune: "Bab El Oued",
    deliveryType: "home",
    validatedProductId: "Fella",
    validatedVariant: { color: "Noir", size: "38" },
    productPrice: 3200,
    deliveryPrice: 400,
    totalPrice: 3600,
    ...overrides,
  };
}

// --- toMinorUnits() ---

test("toMinorUnits() converts an exact 2-decimal value losslessly", () => {
  assert.equal(toMinorUnits(3200, "productPrice"), 320000);
  assert.equal(toMinorUnits(3599.5, "totalPrice"), 359950);
  assert.equal(toMinorUnits(0, "deliveryPrice"), 0);
});

test("toMinorUnits() absorbs floating-point arithmetic noise, not real precision", () => {
  const noisy = 0.1 + 0.2; // 0.30000000000000004 in IEEE-754
  assert.equal(toMinorUnits(noisy, "x"), 30);
});

test("toMinorUnits() rejects a value with a genuine sub-cent component", () => {
  assert.throws(() => toMinorUnits(3200.005, "productPrice"), RangeError);
});

// --- buildCanonicalPayload() / computeFingerprint() ---

test("buildCanonicalPayload() stores prices as integer minor units and preserves text verbatim", () => {
  const canonical = buildCanonicalPayload(basePayload());
  assert.equal(canonical.productPriceMinor, 320000);
  assert.equal(canonical.deliveryPriceMinor, 40000);
  assert.equal(canonical.totalPriceMinor, 360000);
  assert.equal(canonical.customerName, "Amina");
  assert.equal(canonical.validatedVariantColor, "Noir");
  assert.equal(canonical.validatedVariantSize, "38");
});

test("computeFingerprint() is deterministic for identical canonical payloads", () => {
  const a = computeFingerprint(buildCanonicalPayload(basePayload()));
  const b = computeFingerprint(buildCanonicalPayload(basePayload()));
  assert.equal(a, b);
});

test("computeFingerprint() does not normalize text - a case-only difference changes the fingerprint", () => {
  const a = computeFingerprint(buildCanonicalPayload(basePayload({ customerName: "Amina" })));
  const b = computeFingerprint(buildCanonicalPayload(basePayload({ customerName: "AMINA" })));
  assert.notEqual(a, b, "normalize() must not be applied to payload text fields");
});

test("computeFingerprint() changes when a genuinely different price is used", () => {
  const a = computeFingerprint(buildCanonicalPayload(basePayload({ totalPrice: 3600 })));
  const b = computeFingerprint(buildCanonicalPayload(basePayload({ totalPrice: 3600.5 })));
  assert.notEqual(a, b);
});

// --- computeOrderId() ---

test("computeOrderId() is deterministic and 96 bits (24 hex chars) with a DL- prefix", () => {
  const id = computeOrderId("wamid.abc123");
  assert.match(id, /^DL-[0-9a-f]{24}$/);
  assert.equal(id, computeOrderId("wamid.abc123"));
});

test("computeOrderId() differs for different idempotency keys", () => {
  assert.notEqual(computeOrderId("wamid.1"), computeOrderId("wamid.2"));
});

// --- diffConflictingFields() ---

test("diffConflictingFields() reports the caller-facing field name for a price difference", () => {
  const existing = buildCanonicalPayload(basePayload({ totalPrice: 3600 }));
  const next = buildCanonicalPayload(basePayload({ totalPrice: 3650 }));
  assert.deepEqual(diffConflictingFields(existing, next), ["totalPrice"]);
});

test("diffConflictingFields() reports dot-path names for validatedVariant fields", () => {
  const existing = buildCanonicalPayload(basePayload());
  const next = buildCanonicalPayload(basePayload({ validatedVariant: { color: "Blanc", size: "38" } }));
  assert.deepEqual(diffConflictingFields(existing, next), ["validatedVariant.color"]);
});

test("diffConflictingFields() returns an empty array for identical canonical payloads", () => {
  const a = buildCanonicalPayload(basePayload());
  const b = buildCanonicalPayload(basePayload());
  assert.deepEqual(diffConflictingFields(a, b), []);
});

// --- toOrderView() ---

test("toOrderView() maps exactly id/total/createdAt per the approved contract", () => {
  const row = {
    order_id: "DL-abc123",
    payload_json: { totalPriceMinor: 360000 },
    created_at: "2026-07-16T10:00:00.000Z",
  };
  assert.deepEqual(toOrderView(row), { id: "DL-abc123", total: 3600, createdAt: "2026-07-16T10:00:00.000Z" });
});

// --- createOrderRecord() against a fake Postgres pool ---

function makeFakePool() {
  const rowsByKey = new Map();
  const rowsById = new Map();
  let nextId = 1;

  return {
    async query(sql, params) {
      if (sql.includes("INSERT INTO orders")) {
        const [idempotencyKey, fingerprint, orderId, payloadJson] = params;
        if (rowsByKey.has(idempotencyKey)) return { rowCount: 0, rows: [] };
        const row = {
          id: nextId++,
          idempotency_key: idempotencyKey,
          payload_fingerprint: fingerprint,
          order_id: orderId,
          payload_json: payloadJson,
          created_at: new Date().toISOString(),
          projection_status: "pending",
          projected_at: null,
          projection_attempts: 0,
          last_projection_error: null,
        };
        rowsByKey.set(idempotencyKey, row);
        rowsById.set(row.id, row);
        return { rowCount: 1, rows: [row] };
      }
      if (sql.includes("SELECT * FROM orders WHERE idempotency_key")) {
        const row = rowsByKey.get(params[0]);
        return { rowCount: row ? 1 : 0, rows: row ? [row] : [] };
      }
      if (sql.includes("UPDATE orders SET projection_status = 'projected'")) {
        const row = rowsById.get(params[0]);
        row.projection_status = "projected";
        row.projected_at = new Date().toISOString();
        return { rowCount: 1 };
      }
      if (sql.includes("projection_status = 'failed'")) {
        const row = rowsById.get(params[0]);
        row.projection_status = "failed";
        row.projection_attempts = (row.projection_attempts || 0) + 1;
        row.last_projection_error = params[1];
        return { rowCount: 1 };
      }
      throw new Error(`fake pool: unrecognized query: ${sql}`);
    },
    rowsByKey,
  };
}

function makeFakeSheets() {
  const headerRow = [
    "created_at", "order_id", "customer_name", "phone", "wilaya", "commune", "delivery_type",
    "product", "color", "size", "quantity", "unit_price", "shipping_price", "total", "status", "source", "notes",
    "message_id",
  ];
  const dataRows = [];
  return {
    getValuesFn: async () => [headerRow, ...dataRows],
    appendValuesFn: async (_range, values) => { dataRows.push(...values); },
    headerRow,
    dataRows,
  };
}

function makeFakeLogger() {
  const warnings = [];
  const errors = [];
  return { warn: (msg) => warnings.push(msg), error: (msg) => errors.push(msg), log() {}, warnings, errors };
}

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 20));
}

test("createOrderRecord() returns created with the correct toOrderView shape on first call", async () => {
  const pool = makeFakePool();
  const sheets = makeFakeSheets();
  const { createOrderRecord } = createOrderPersistence({ pool, ordersTab: "ORDERS", ...sheets, logger: makeFakeLogger() });

  const result = await createOrderRecord("wamid.1", basePayload());

  assert.equal(result.outcome, "created");
  assert.equal(result.order.id, computeOrderId("wamid.1"));
  assert.equal(result.order.total, 3600);
});

test("T-IDEM-1: a repeated idempotencyKey returns already_created, not a second row", async () => {
  const pool = makeFakePool();
  const sheets = makeFakeSheets();
  const { createOrderRecord } = createOrderPersistence({ pool, ordersTab: "ORDERS", ...sheets, logger: makeFakeLogger() });

  const first = await createOrderRecord("wamid.1", basePayload());
  const second = await createOrderRecord("wamid.1", basePayload());

  assert.equal(first.outcome, "created");
  assert.equal(second.outcome, "already_created");
  assert.deepEqual(second.order, first.order);
  assert.equal(pool.rowsByKey.size, 1);
});

test("same key, genuinely different price returns conflict with conflictingFields", async () => {
  const pool = makeFakePool();
  const sheets = makeFakeSheets();
  const { createOrderRecord } = createOrderPersistence({ pool, ordersTab: "ORDERS", ...sheets, logger: makeFakeLogger() });

  await createOrderRecord("wamid.1", basePayload({ totalPrice: 3600 }));
  const conflictResult = await createOrderRecord("wamid.1", basePayload({ totalPrice: 3600.5 }));

  assert.equal(conflictResult.outcome, "conflict");
  assert.deepEqual(conflictResult.conflictingFields, ["totalPrice"]);
  assert.ok(conflictResult.order, "conflict result must echo the existing stored order");
});

test("createOrderRecord() resolves without waiting on inline projection to finish", async () => {
  const pool = makeFakePool();
  let resolveAppend;
  const neverResolvingAppend = () => new Promise((resolve) => { resolveAppend = resolve; });
  const logger = makeFakeLogger();
  const { createOrderRecord } = createOrderPersistence({
    pool,
    ordersTab: "ORDERS",
    getValuesFn: async () => [[...ORDER_HEADERS]],
    appendValuesFn: neverResolvingAppend,
    logger,
  });

  const result = await createOrderRecord("wamid.1", basePayload());
  assert.equal(result.outcome, "created", "must resolve even though the inline Sheets append hasn't settled yet");

  await settle(); // let the fire-and-forget chain reach appendValuesFn() before we unblock it
  assert.equal(typeof resolveAppend, "function", "appendValuesFn should have been invoked by now");
  resolveAppend([]);
  await settle();
});

test("a failed inline projection eventually marks the row failed, increments attempts exactly once, and records the error", async () => {
  const pool = makeFakePool();
  const logger = makeFakeLogger();
  const { createOrderRecord } = createOrderPersistence({
    pool,
    ordersTab: "ORDERS",
    getValuesFn: async () => [[...ORDER_HEADERS]],
    appendValuesFn: async () => { throw new Error("Sheets quota exceeded"); },
    logger,
  });

  const result = await createOrderRecord("wamid.1", basePayload());
  assert.equal(result.outcome, "created", "must resolve as created without waiting for the projection outcome");

  await settle();

  const row = pool.rowsByKey.get("wamid.1");
  assert.equal(row.projection_status, "failed", "pending -> failed once the inline attempt settles with a rejection");
  assert.equal(row.projection_attempts, 1);
  assert.equal(row.last_projection_error, "Sheets quota exceeded");
  assert.equal(logger.warnings.length, 1);
  assert.match(logger.warnings[0], /inline projection failed/);
});

test("a failure while persisting the failed-status update is caught and logged, never an unhandled rejection", async () => {
  const insertedRow = {
    id: 1,
    idempotency_key: "wamid.1",
    order_id: computeOrderId("wamid.1"),
    payload_json: null,
    created_at: new Date().toISOString(),
    projection_status: "pending",
    projection_attempts: 0,
    last_projection_error: null,
  };
  const pool = {
    async query(sql, params) {
      if (sql.includes("INSERT INTO orders")) {
        insertedRow.payload_json = params[3];
        return { rowCount: 1, rows: [insertedRow] };
      }
      if (sql.includes("projection_status = 'failed'")) {
        throw new Error("connection pool exhausted");
      }
      throw new Error(`unexpected query in this test: ${sql}`);
    },
  };
  const logger = makeFakeLogger();
  const { createOrderRecord } = createOrderPersistence({
    pool,
    ordersTab: "ORDERS",
    getValuesFn: async () => [[...ORDER_HEADERS]],
    appendValuesFn: async () => { throw new Error("Sheets quota exceeded"); },
    logger,
  });

  const result = await createOrderRecord("wamid.1", basePayload());
  assert.equal(result.outcome, "created");

  await settle();

  // Reaching this line at all (rather than the process crashing on an
  // unhandled rejection) is itself part of what this test proves.
  assert.equal(logger.warnings.length, 1, "the original projection-failure warning must still be logged");
  assert.equal(logger.errors.length, 1, "the status-update failure must be logged separately as an operational error");
  assert.match(logger.errors[0], /failed to persist projection-failure status/);
  assert.equal(insertedRow.projection_status, "pending", "a failed status-update must not fabricate a 'failed' state");
});

test("a successful inline projection appends exactly one Sheets row and marks the Postgres row projected", async () => {
  const pool = makeFakePool();
  const sheets = makeFakeSheets();
  const { createOrderRecord } = createOrderPersistence({ pool, ordersTab: "ORDERS", ...sheets, logger: makeFakeLogger() });

  await createOrderRecord("wamid.1", basePayload());
  await settle();

  assert.equal(sheets.dataRows.length, 1);
  assert.equal(sheets.dataRows[0][sheets.headerRow.indexOf("message_id")], "wamid.1");
  assert.equal(pool.rowsByKey.get("wamid.1").projection_status, "projected");
});

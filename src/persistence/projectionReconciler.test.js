// Tests for the Sheets projection reconciler (Sprint 3 Task 3 persistence-
// adapter planning).
// Run with: node --test src/persistence/projectionReconciler.test.js
//
// No live Postgres or Google Sheets call anywhere in this file - pool,
// getValuesFn, and appendValuesFn are always fakes, injected via deps.
// These tests prove detection/repair-eligibility logic and advisory-lock
// connection discipline; they do not, and cannot, prove real multi-instance
// Render behavior or a real Postgres advisory lock's actual semantics -
// that requires a real-Postgres integration test, out of scope for this
// stage (no DATABASE_URL has been requested or set).

import test from "node:test";
import assert from "node:assert/strict";
import { ORDER_HEADERS } from "./orderSheetSchema.js";
import {
  PROJECTION_HEADERS,
  STALLED_ATTEMPT_THRESHOLD,
  STALLED_STALENESS_MS,
  rowToSheetsRow,
  isStalled,
  projectOrderRow,
  markProjectionFailed,
  runReconciliationSweep,
  runStartupRecovery,
  detectDuplicateProjections,
} from "./projectionReconciler.js";

test("ORDER_HEADERS defines the exact shared 18-column contract", () => {
  assert.deepEqual(ORDER_HEADERS, [
    "created_at", "order_id", "customer_name", "phone", "wilaya", "commune", "delivery_type",
    "product", "color", "size", "quantity", "unit_price", "shipping_price", "total", "status", "source", "notes",
    "message_id",
  ]);
  assert.equal(ORDER_HEADERS.length, 18);
  assert.equal(ORDER_HEADERS.at(-1), "message_id");
});

test("PROJECTION_HEADERS uses the shared ORDER_HEADERS contract", () => {
  assert.strictEqual(PROJECTION_HEADERS, ORDER_HEADERS);
});

function makeOrderRow(overrides = {}) {
  return {
    id: 1,
    idempotency_key: "wamid.1",
    order_id: "DL-abc123",
    payload_json: {
      customerName: "Amina",
      phone: "0555000000",
      wilaya: "Alger",
      commune: "Bab El Oued",
      deliveryType: "home",
      validatedProductId: "Fella",
      validatedVariantColor: "Noir",
      validatedVariantSize: "38",
      productPriceMinor: 320000,
      deliveryPriceMinor: 40000,
      totalPriceMinor: 360000,
    },
    created_at: new Date().toISOString(),
    projection_status: "pending",
    projection_attempts: 0,
    last_projection_error: null,
    ...overrides,
  };
}

// --- rowToSheetsRow() ---

test("rowToSheetsRow() maps a Postgres row onto PROJECTION_HEADERS in order, defaulting quantity to 1", () => {
  const row = makeOrderRow();
  const sheetsRow = rowToSheetsRow(row);

  assert.equal(sheetsRow.length, PROJECTION_HEADERS.length);
  assert.equal(sheetsRow[PROJECTION_HEADERS.indexOf("order_id")], "DL-abc123");
  assert.equal(sheetsRow[PROJECTION_HEADERS.indexOf("customer_name")], "Amina");
  assert.equal(sheetsRow[PROJECTION_HEADERS.indexOf("quantity")], 1);
  assert.equal(sheetsRow[PROJECTION_HEADERS.indexOf("unit_price")], 3200);
  assert.equal(sheetsRow[PROJECTION_HEADERS.indexOf("total")], 3600);
  assert.equal(sheetsRow[PROJECTION_HEADERS.indexOf("message_id")], "wamid.1");
});

// --- isStalled() ---

test("isStalled() is true once projection_attempts reaches the threshold", () => {
  assert.equal(isStalled(makeOrderRow({ projection_attempts: STALLED_ATTEMPT_THRESHOLD })), true);
  assert.equal(isStalled(makeOrderRow({ projection_attempts: STALLED_ATTEMPT_THRESHOLD - 1 })), false);
});

test("isStalled() is true once the row is older than the staleness window", () => {
  const old = new Date(Date.now() - STALLED_STALENESS_MS - 1000).toISOString();
  assert.equal(isStalled(makeOrderRow({ created_at: old, projection_attempts: 0 })), true);
});

test("isStalled() is false for a fresh row with no failed attempts", () => {
  assert.equal(isStalled(makeOrderRow()), false);
});

// --- projectOrderRow() ---

function makeFakeSheets(existingRows = []) {
  const headerRow = [...ORDER_HEADERS];
  const dataRows = [...existingRows];
  return {
    getValuesFn: async () => [headerRow, ...dataRows],
    appendValuesFn: async (_range, values) => { dataRows.push(...values); },
    headerRow,
    dataRows,
  };
}

function makeFakePoolForUpdateOnly() {
  const calls = [];
  return {
    async query(sql, params) {
      calls.push({ sql, params });
      return { rowCount: 1, rows: [] };
    },
    calls,
  };
}

test("projectOrderRow() appends a row when none exists yet for the message_id", async () => {
  const sheets = makeFakeSheets();
  const pool = makeFakePoolForUpdateOnly();
  const row = makeOrderRow();

  const result = await projectOrderRow(row, { pool, ordersTab: "ORDERS", ...sheets });

  assert.equal(result.skipped, false);
  assert.equal(sheets.dataRows.length, 1);
  assert.ok(pool.calls.some((c) => c.sql.includes("projection_status = 'projected'")));
});

test("projectOrderRow() is a no-op append when a row for the message_id already exists (idempotent retry)", async () => {
  const existingRow = new Array(ORDER_HEADERS.length).fill("");
  existingRow[ORDER_HEADERS.indexOf("message_id")] = "wamid.1";
  const sheets = makeFakeSheets([existingRow]);
  const pool = makeFakePoolForUpdateOnly();
  const row = makeOrderRow({ idempotency_key: "wamid.1" });

  const result = await projectOrderRow(row, { pool, ordersTab: "ORDERS", ...sheets });

  assert.equal(result.skipped, true);
  assert.equal(sheets.dataRows.length, 1, "must not append a second Sheets row for the same message_id");
});

test("projectOrderRow() fails closed when message_id is missing", async () => {
  const pool = makeFakePoolForUpdateOnly();
  let appendAttempted = false;

  await assert.rejects(
    projectOrderRow(makeOrderRow(), {
      pool,
      ordersTab: "ORDERS",
      getValuesFn: async () => [ORDER_HEADERS.slice(0, -1)],
      appendValuesFn: async () => { appendAttempted = true; },
    }),
    /expected trailing message_id header at column R/
  );

  assert.equal(appendAttempted, false, "must not append without the required message_id header");
  assert.equal(pool.calls.length, 0, "must not mark the row projected after a schema failure");
});

test("projectOrderRow() fails closed when message_id is not the trailing column R header", async () => {
  const pool = makeFakePoolForUpdateOnly();
  const misplacedHeaders = [...ORDER_HEADERS];
  [misplacedHeaders[16], misplacedHeaders[17]] = [misplacedHeaders[17], misplacedHeaders[16]];
  let appendAttempted = false;

  await assert.rejects(
    projectOrderRow(makeOrderRow(), {
      pool,
      ordersTab: "ORDERS",
      getValuesFn: async () => [misplacedHeaders],
      appendValuesFn: async () => { appendAttempted = true; },
    }),
    /expected trailing message_id header at column R/
  );

  assert.equal(appendAttempted, false, "must not append when message_id is misplaced");
  assert.equal(pool.calls.length, 0, "must not mark the row projected after a schema failure");
});

// --- markProjectionFailed() - shared by the inline path and the sweep ---

test("markProjectionFailed() sets status failed, increments attempts by one, and records the error", async () => {
  const pool = makeFakePoolForUpdateOnly();
  const row = makeOrderRow({ id: 7 });

  await markProjectionFailed(row, new Error("Sheets quota exceeded"), { pool });

  const call = pool.calls.find((c) => c.sql.includes("projection_status = 'failed'"));
  assert.ok(call, "must issue the failed-status UPDATE");
  assert.deepEqual(call.params, [7, "Sheets quota exceeded"]);
});

test("markProjectionFailed() sanitizes a multi-line, overlong error message before persisting it", async () => {
  const pool = makeFakePoolForUpdateOnly();
  const row = makeOrderRow({ id: 1 });
  const longMessage = `line one\nline two\n${"x".repeat(600)}`;

  await markProjectionFailed(row, new Error(longMessage), { pool });

  const [{ params }] = pool.calls;
  assert.equal(params[0], 1);
  assert.ok(!params[1].includes("\n"), "sanitized error must not contain newlines");
  assert.ok(params[1].length <= 501, "sanitized error must be capped in length");
});

// --- Advisory lock connection discipline (binding clarification 5) ---

function makeFakePoolWithDedicatedClient(initialRows) {
  const rows = new Map(initialRows.map((r) => [r.id, { ...r }]));
  let lockHeld = false;
  const clientQueries = [];
  const poolLevelQueries = [];

  async function runQuery(sql, params) {
    if (sql.startsWith("SELECT pg_try_advisory_lock")) {
      if (lockHeld) return { rows: [{ locked: false }] };
      lockHeld = true;
      return { rows: [{ locked: true }] };
    }
    if (sql.startsWith("SELECT pg_advisory_unlock")) {
      lockHeld = false;
      return { rows: [{}] };
    }
    if (sql.includes("SELECT * FROM orders WHERE projection_status")) {
      return { rows: [...rows.values()].filter((r) => r.projection_status !== "projected") };
    }
    if (sql.includes("projection_status = 'projected'")) {
      rows.get(params[0]).projection_status = "projected";
      return { rowCount: 1 };
    }
    if (sql.includes("projection_status = 'failed'")) {
      const row = rows.get(params[0]);
      row.projection_attempts = (row.projection_attempts || 0) + 1;
      row.last_projection_error = params[1];
      row.projection_status = "failed";
      return { rowCount: 1 };
    }
    throw new Error(`fake client: unrecognized query: ${sql}`);
  }

  const client = {
    released: false,
    async query(sql, params) { clientQueries.push(sql); return runQuery(sql, params); },
    release() { client.released = true; },
  };

  return {
    pool: {
      async connect() { return client; },
      async query(sql, params) { poolLevelQueries.push(sql); return runQuery(sql, params); },
    },
    client,
    rows,
    clientQueries,
    poolLevelQueries,
  };
}

test("runReconciliationSweep() acquires, uses, and releases the advisory lock through one dedicated client", async () => {
  const { pool, client, clientQueries, poolLevelQueries } = makeFakePoolWithDedicatedClient([
    makeOrderRow({ id: 1, projection_status: "pending" }),
  ]);
  const sheets = makeFakeSheets();

  await runReconciliationSweep({ pool, ordersTab: "ORDERS", ...sheets, logger: { log() {}, error() {}, warn() {} } });

  assert.ok(clientQueries.some((s) => s.startsWith("SELECT pg_try_advisory_lock")));
  assert.ok(clientQueries.some((s) => s.startsWith("SELECT pg_advisory_unlock")));
  assert.ok(clientQueries.some((s) => s.includes("SELECT * FROM orders WHERE projection_status")));
  assert.equal(poolLevelQueries.length, 0, "all sweep work must go through the dedicated client, never pool.query()");
  assert.equal(client.released, true, "the dedicated client must be released back to the pool");
});

test("runReconciliationSweep() skips the pass when another instance already holds the advisory lock", async () => {
  const { pool } = makeFakePoolWithDedicatedClient([makeOrderRow()]);
  // Simulate a lock already held by acquiring it first through a separate connect() call.
  const holder = await pool.connect();
  await holder.query("SELECT pg_try_advisory_lock($1) AS locked", [725100]);

  const result = await runReconciliationSweep({
    pool,
    ordersTab: "ORDERS",
    ...makeFakeSheets(),
    logger: { log() {}, error() {}, warn() {} },
  });

  assert.equal(result.skipped, true);
  holder.release();
});

test("runReconciliationSweep() increments projection_attempts by exactly one per failing pass", async () => {
  const row = makeOrderRow({ id: 1, projection_status: "pending", projection_attempts: 2 });
  const { pool, rows } = makeFakePoolWithDedicatedClient([row]);

  await runReconciliationSweep({
    pool,
    ordersTab: "ORDERS",
    getValuesFn: async () => [[...ORDER_HEADERS]],
    appendValuesFn: async () => { throw new Error("Sheets quota exceeded"); },
    logger: { log() {}, error() {}, warn() {} },
  });

  assert.equal(rows.get(1).projection_attempts, 3, "one failing sweep pass must add exactly one attempt, not two");
  assert.equal(rows.get(1).projection_status, "failed");
});

test("runReconciliationSweep() logs a distinctly-labeled line for a stalled row and leaves it for manual review", async () => {
  const staleRow = makeOrderRow({
    id: 1,
    projection_status: "failed",
    projection_attempts: STALLED_ATTEMPT_THRESHOLD,
  });
  const { pool } = makeFakePoolWithDedicatedClient([staleRow]);
  const errors = [];
  const failingAppend = async () => { throw new Error("Sheets quota exceeded"); };

  await runReconciliationSweep({
    pool,
    ordersTab: "ORDERS",
    getValuesFn: async () => [[...ORDER_HEADERS]],
    appendValuesFn: failingAppend,
    logger: { log() {}, error: (msg) => errors.push(msg), warn() {} },
  });

  assert.equal(errors.length, 1);
  assert.match(errors[0], /STALLED/);
  assert.match(errors[0], /requires manual review/);
});

test("runStartupRecovery() runs the same sweep logic", async () => {
  const { pool } = makeFakePoolWithDedicatedClient([makeOrderRow()]);
  const result = await runStartupRecovery({
    pool,
    ordersTab: "ORDERS",
    ...makeFakeSheets(),
    logger: { log() {}, error() {}, warn() {} },
  });
  assert.equal(result.found, 1);
});

// --- detectDuplicateProjections() - detection only ---

test("detectDuplicateProjections() flags a message_id appearing more than once, without touching Sheets", async () => {
  const headerRow = [...(makeFakeSheets().headerRow)];
  const idx = headerRow.indexOf("message_id");
  const rowA = new Array(headerRow.length).fill("");
  rowA[idx] = "wamid.dup";
  const rowB = new Array(headerRow.length).fill("");
  rowB[idx] = "wamid.dup";
  const rowC = new Array(headerRow.length).fill("");
  rowC[idx] = "wamid.unique";

  let writeAttempted = false;
  const deps = {
    ordersTab: "ORDERS",
    getValuesFn: async () => [headerRow, rowA, rowB, rowC],
    appendValuesFn: async () => { writeAttempted = true; },
  };

  const duplicates = await detectDuplicateProjections(deps);

  assert.deepEqual(duplicates, [{ messageId: "wamid.dup", count: 2 }]);
  assert.equal(writeAttempted, false, "detection must never write to Sheets");
});

test("detectDuplicateProjections() returns an empty array when every message_id is unique", async () => {
  const sheets = makeFakeSheets();
  const row = new Array(sheets.headerRow.length).fill("");
  row[sheets.headerRow.indexOf("message_id")] = "wamid.only";
  const duplicates = await detectDuplicateProjections({
    ordersTab: "ORDERS",
    getValuesFn: async () => [sheets.headerRow, row],
  });
  assert.deepEqual(duplicates, []);
});

test("detectDuplicateProjections() fails closed when message_id is missing", async () => {
  await assert.rejects(
    detectDuplicateProjections({
      ordersTab: "ORDERS",
      getValuesFn: async () => [ORDER_HEADERS.slice(0, -1)],
    }),
    /expected trailing message_id header at column R/
  );
});

test("detectDuplicateProjections() fails closed when message_id is misplaced", async () => {
  const misplacedHeaders = [...ORDER_HEADERS];
  [misplacedHeaders[16], misplacedHeaders[17]] = [misplacedHeaders[17], misplacedHeaders[16]];

  await assert.rejects(
    detectDuplicateProjections({
      ordersTab: "ORDERS",
      getValuesFn: async () => [misplacedHeaders],
    }),
    /expected trailing message_id header at column R/
  );
});

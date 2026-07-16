// Sheets-facing "projection" of already-durable Postgres orders rows.
//
// Owns three things: inline single-row projection (called by
// orderPersistence.js as a best-effort latency optimization only),
// a periodic reconciliation sweep, and startup recovery for anything left
// pending/failed by a prior process instance's crash or redeploy.
//
// A durable pending/failed Postgres row guarantees projection *intent* and
// retry-eligibility - it does not guarantee unconditional eventual
// appearance in Sheets. It cannot self-heal from this process never
// running, permanently invalid Sheets credentials, or sustained quota
// exhaustion. Rows that cross the stalled threshold below are logged
// distinctly for manual review rather than retried silently forever.
//
// Duplicate-projection handling here is detection only - this module never
// deletes, edits, or otherwise repairs a Sheets row.
//
// Not wired into orderEngine.js, server.js, or any production path. deps
// (pool, getValuesFn, appendValuesFn, ordersTab, logger) are always
// injected; there is no default, network-capable dependency.
//
import { colLetter } from "../utils.js";
import { ORDER_HEADERS } from "./orderSheetSchema.js";

export const PROJECTION_HEADERS = ORDER_HEADERS;

export const STALLED_ATTEMPT_THRESHOLD = 5;
export const STALLED_STALENESS_MS = 30 * 60 * 1000;

// OrderState (DASP-004 §5.2) has no quantity field, unlike store.js's
// legacy ORDER_HEADERS - defaulted to 1 pending a documented decision on
// where quantity belongs, not invented business logic.
export function rowToSheetsRow(row) {
  const p = row.payload_json;
  return PROJECTION_HEADERS.map((header) => {
    switch (header) {
      case "created_at": return new Date(row.created_at).toISOString();
      case "order_id": return row.order_id;
      case "customer_name": return p.customerName;
      case "phone": return p.phone;
      case "wilaya": return p.wilaya;
      case "commune": return p.commune;
      case "delivery_type": return p.deliveryType;
      case "product": return p.validatedProductId;
      case "color": return p.validatedVariantColor;
      case "size": return p.validatedVariantSize;
      case "quantity": return 1;
      case "unit_price": return p.productPriceMinor / 100;
      case "shipping_price": return p.deliveryPriceMinor / 100;
      case "total": return p.totalPriceMinor / 100;
      case "status": return "NEW";
      case "source": return "WhatsApp Bot";
      case "notes": return "";
      case "message_id": return row.idempotency_key;
      default: return "";
    }
  });
}

function buildOrdersRange(tab) {
  return `'${tab}'!A:${colLetter(PROJECTION_HEADERS.length)}`;
}

const MESSAGE_ID_COLUMN_INDEX = ORDER_HEADERS.length - 1;

function requireMessageIdColumn(values) {
  const headers = values[0];
  if (
    !Array.isArray(headers) ||
    headers.length !== ORDER_HEADERS.length ||
    headers[MESSAGE_ID_COLUMN_INDEX] !== "message_id"
  ) {
    throw new Error("ORDERS sheet schema mismatch: expected trailing message_id header at column R");
  }
  return MESSAGE_ID_COLUMN_INDEX;
}

async function findExistingProjectionRow(messageId, deps) {
  const { getValuesFn, ordersTab } = deps;
  const values = await getValuesFn(`'${ordersTab}'!A:ZZ`, { ttlMs: 0 });
  const idx = requireMessageIdColumn(values);
  if (values.length < 2) return null;

  return values.slice(1).find((r) => String(r[idx] ?? "") === messageId) || null;
}

// Fresh-Read-before-append makes this safe to call more than once for the
// same row (inline attempt, then a later sweep pass catching the same row)
// - at worst it produces a duplicate Sheets row, never a duplicate order,
// since Postgres's idempotency_key UNIQUE constraint is what actually
// prevents that. Detection of any such duplicate is
// detectDuplicateProjections()'s job, not this function's.
export async function projectOrderRow(row, deps) {
  const { pool, getValuesFn, appendValuesFn, ordersTab } = deps;
  if (typeof getValuesFn !== "function" || typeof appendValuesFn !== "function") {
    throw new TypeError("projectOrderRow(): deps.getValuesFn and deps.appendValuesFn are required");
  }
  if (!ordersTab) {
    throw new TypeError("projectOrderRow(): deps.ordersTab is required");
  }

  const existing = await findExistingProjectionRow(row.idempotency_key, deps);
  if (!existing) {
    await appendValuesFn(buildOrdersRange(ordersTab), [rowToSheetsRow(row)]);
  }

  await pool.query(
    `UPDATE orders SET projection_status = 'projected', projected_at = now() WHERE id = $1`,
    [row.id]
  );
  return { projected: true, skipped: Boolean(existing) };
}

const MAX_ERROR_MESSAGE_LENGTH = 500;

// Collapses to one line and caps length before this ever reaches a
// Postgres column - error messages can otherwise carry raw stack traces,
// embedded newlines, or unbounded length from an upstream library.
function sanitizeErrorMessage(err) {
  const raw = String((err && err.message) || err || "unknown error").replace(/\s+/g, " ").trim();
  return raw.length > MAX_ERROR_MESSAGE_LENGTH ? `${raw.slice(0, MAX_ERROR_MESSAGE_LENGTH)}…` : raw;
}

// Shared by both the sweep (runProjectionPass, below) and orderPersistence.js's
// inline fire-and-forget attempt - the single place that ever sets
// projection_status='failed', so the two call sites can never drift apart
// on what "failed" means or how the error is recorded.
export async function markProjectionFailed(row, err, deps) {
  await deps.pool.query(
    `UPDATE orders
     SET projection_status = 'failed', projection_attempts = projection_attempts + 1, last_projection_error = $2
     WHERE id = $1`,
    [row.id, sanitizeErrorMessage(err)]
  );
}

export function isStalled(row) {
  const attempts = row.projection_attempts || 0;
  const ageMs = Date.now() - new Date(row.created_at).getTime();
  return attempts >= STALLED_ATTEMPT_THRESHOLD || ageMs >= STALLED_STALENESS_MS;
}

const PENDING_SQL = `SELECT * FROM orders WHERE projection_status IN ('pending', 'failed') ORDER BY created_at ASC`;

async function runProjectionPass(deps) {
  const { pool, logger = console } = deps;
  const { rows } = await pool.query(PENDING_SQL);

  let projected = 0;
  let stillFailing = 0;
  let newlyStalled = 0;

  for (const row of rows) {
    try {
      await projectOrderRow(row, deps);
      projected++;
    } catch (err) {
      await markProjectionFailed(row, err, deps);
      stillFailing++;
      if (isStalled(row)) {
        newlyStalled++;
        logger.error(
          `[projectionReconciler] STALLED - order ${row.order_id} (message_id ${row.idempotency_key}) requires manual review: ` +
          `${(row.projection_attempts || 0) + 1} attempts, created ${row.created_at}, last error: ${err.message}`
        );
      }
    }
  }

  logger.log(
    `[projectionReconciler] sweep complete: ${rows.length} pending, ${projected} projected, ${stillFailing} still failing, ${newlyStalled} newly stalled`
  );
  return { found: rows.length, projected, stillFailing, newlyStalled };
}

// Fixed, arbitrary key identifying this sweep's advisory-lock class only -
// not tied to any row or business identifier.
const ADVISORY_LOCK_KEY = 725100;

// Acquires, uses, and releases the advisory lock through one dedicated
// client for the entire pass (deps.pool.connect(), not deps.pool.query()):
// PostgreSQL session-level advisory locks are bound to the specific backend
// connection that took them, so running the protected work on a different
// pooled connection would give the lock no effect at all. Not load-bearing
// for correctness (idempotency_key UNIQUE already prevents duplicate
// orders regardless of sweep overlap) - this only reduces how often two
// instances' sweeps race and produce the cosmetic duplicate-Sheets-row case
// that detectDuplicateProjections() exists to catch.
export async function runReconciliationSweep(deps) {
  const { pool, logger = console } = deps;
  const client = await pool.connect();
  try {
    const { rows } = await client.query("SELECT pg_try_advisory_lock($1) AS locked", [ADVISORY_LOCK_KEY]);
    if (!rows[0].locked) {
      logger.log("[projectionReconciler] sweep skipped - another instance holds the advisory lock");
      return { skipped: true };
    }
    try {
      return await runProjectionPass({ ...deps, pool: client });
    } finally {
      await client.query("SELECT pg_advisory_unlock($1)", [ADVISORY_LOCK_KEY]);
    }
  } finally {
    client.release();
  }
}

// Same sweep, run once immediately at process start to catch rows left
// pending/failed by a prior instance's crash or redeploy - not a separate
// code path from the periodic sweep.
export async function runStartupRecovery(deps) {
  return runReconciliationSweep(deps);
}

// Detection only - never deletes, edits, or otherwise repairs a Sheets row.
export async function detectDuplicateProjections(deps) {
  const { getValuesFn, ordersTab } = deps;
  const values = await getValuesFn(`'${ordersTab}'!A:ZZ`, { ttlMs: 0 });
  const idx = requireMessageIdColumn(values);
  if (values.length < 2) return [];

  const counts = new Map();
  for (const row of values.slice(1)) {
    const key = String(row[idx] ?? "");
    if (!key) continue;
    counts.set(key, (counts.get(key) || 0) + 1);
  }

  return [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([messageId, count]) => ({ messageId, count }));
}

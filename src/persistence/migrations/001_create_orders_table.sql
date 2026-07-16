-- Sprint 3 Task 3 persistence adapter - authoritative durable order record.
--
-- NOT applied by this implementation stage. This file is a reviewable
-- artifact only: no migration runner has been invoked, no Postgres
-- instance has been connected to, and no DATABASE_URL has been requested
-- or set. Applying this migration is a separate, explicitly-approved stage.
--
-- idempotency_key UNIQUE is the sole atomicity primitive this whole design
-- depends on: INSERT ... ON CONFLICT (idempotency_key) DO NOTHING is the
-- entire durable idempotency decision for createOrderRecord(). order_id
-- UNIQUE is defense-in-depth only, not the correctness mechanism.
--
-- payload_json stores the canonical payload exactly as fingerprinted
-- (src/persistence/orderPersistence.js:buildCanonicalPayload) - prices as
-- integer minor units (productPriceMinor/deliveryPriceMinor/totalPriceMinor),
-- all other fields verbatim/unnormalized.
--
-- projection_status/projected_at/projection_attempts/last_projection_error
-- track Sheets projection as a separately-eventually-consistent concern -
-- see src/persistence/projectionReconciler.js. A row's mere existence here,
-- regardless of projection_status, already means the order is durably
-- created; projection_status only ever affects Sheets visibility, never
-- order durability.

CREATE TABLE orders (
  id                     BIGSERIAL PRIMARY KEY,
  idempotency_key        TEXT NOT NULL,
  payload_fingerprint     TEXT NOT NULL,
  order_id               TEXT NOT NULL,
  payload_json            JSONB NOT NULL,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  projection_status       TEXT NOT NULL DEFAULT 'pending',
  projected_at             TIMESTAMPTZ,
  projection_attempts      INTEGER NOT NULL DEFAULT 0,
  last_projection_error    TEXT,

  CONSTRAINT orders_idempotency_key_unique UNIQUE (idempotency_key),
  CONSTRAINT orders_order_id_unique UNIQUE (order_id),
  CONSTRAINT orders_projection_status_check CHECK (projection_status IN ('pending', 'projected', 'failed'))
);

CREATE INDEX orders_projection_status_idx ON orders (projection_status) WHERE projection_status <> 'projected';

import test from "node:test";
import assert from "node:assert/strict";
import { ORDER_HEADERS } from "../persistence/orderSheetSchema.js";
import {
  parseSandboxOrderPilotPhoneAllowlist,
  buildSandboxPilotOrderState,
  createSandboxOrderPilot,
  createConfirmedOrderWithPilot,
} from "./sandboxOrderPilot.js";

function baseSession(overrides = {}) {
  return {
    customer_name: "Amina",
    phone: "213555000001",
    wilaya: "Alger",
    commune: "Bab El Oued",
    delivery_type: "home",
    product: "Fella",
    color: "Noir",
    size: "38",
    quantity: 1,
    ...overrides,
  };
}

function baseProduct(overrides = {}) {
  return { product: "Fella", color: "Noir", size: "38", price: 3200, ...overrides };
}

function makePoolStub() {
  return {
    async query() { return { rowCount: 1, rows: [] }; },
    async end() {},
  };
}

function makeEnabledPilot(overrides = {}) {
  return createSandboxOrderPilot({
    enabled: true,
    phoneAllowlistRaw: "213555000001",
    databaseUrl: "postgresql://not-used-by-this-fake",
    appSecret: "test-app-secret",
    createPool: () => makePoolStub(),
    getValuesFn: async () => [[...ORDER_HEADERS]],
    appendValuesFn: async () => {},
    ordersTab: "ORDERS",
    createOrderPersistenceFn: () => ({ createOrderRecord: async () => ({}) }),
    createIdempotentOrderFn: async () => ({
      status: "created",
      order: { id: "DL-1", total: 3600, createdAt: "2026-07-16T00:00:00.000Z" },
    }),
    ...overrides,
  });
}

test("parseSandboxOrderPilotPhoneAllowlist() trims entries and preserves exact digit-only phone values", () => {
  const phones = parseSandboxOrderPilotPhoneAllowlist(" 213555000001,213555000002 ");
  assert.deepEqual([...phones], ["213555000001", "213555000002"]);
  assert.equal(parseSandboxOrderPilotPhoneAllowlist("   ").size, 0);
  assert.throws(() => parseSandboxOrderPilotPhoneAllowlist("213555000001,+213555000002"), /digit-only/);
  assert.throws(() => parseSandboxOrderPilotPhoneAllowlist("213555000001,"), /digit-only/);
});

test("a disabled pilot does not construct a Pool and is never eligible", async () => {
  let poolConstructed = false;
  const pilot = createSandboxOrderPilot({
    enabled: false,
    createPool: () => { poolConstructed = true; return makePoolStub(); },
  });

  assert.equal(pilot.enabled, false);
  assert.equal(pilot.isEligible("213555000001"), false);
  assert.equal(poolConstructed, false);
  await pilot.close();
});

test("an enabled pilot requires a non-empty valid allowlist, DATABASE_URL, and APP_SECRET", () => {
  const common = { enabled: true, createPool: () => makePoolStub() };
  assert.throws(() => createSandboxOrderPilot({ ...common, phoneAllowlistRaw: "" }), /must be non-empty/);
  assert.throws(
    () => createSandboxOrderPilot({ ...common, phoneAllowlistRaw: "+213555000001" }),
    /digit-only/
  );
  assert.throws(
    () => createSandboxOrderPilot({ ...common, phoneAllowlistRaw: "213555000001", appSecret: "secret" }),
    /DATABASE_URL/
  );
  assert.throws(
    () => createSandboxOrderPilot({
      ...common,
      phoneAllowlistRaw: "213555000001",
      databaseUrl: "postgresql://fake",
    }),
    /APP_SECRET/
  );
});

test("enabled Pool construction uses certificate-verifying TLS and exact allowlist matching", () => {
  let poolOptions;
  const pilot = makeEnabledPilot({
    createPool: (options) => { poolOptions = options; return makePoolStub(); },
  });

  assert.deepEqual(poolOptions, {
    connectionString: "postgresql://not-used-by-this-fake",
    ssl: { rejectUnauthorized: true },
  });
  assert.equal(pilot.isEligible("213555000001"), true);
  assert.equal(pilot.isEligible("555000001"), false);
  assert.equal(pilot.isEligible("2135550000010"), false);
  assert.equal(pilot.isEligible(" 213555000001"), false);
});

test("buildSandboxPilotOrderState() maps the legacy values into the confirmed quantity-1 contract", () => {
  assert.deepEqual(buildSandboxPilotOrderState(baseSession(), baseProduct(), 400), {
    stage: "confirmed",
    customerName: "Amina",
    phone: "213555000001",
    wilaya: "Alger",
    commune: "Bab El Oued",
    deliveryType: "home",
    validatedProductId: "Fella",
    validatedVariant: { color: "Noir", size: "38" },
    productPrice: 3200,
    deliveryPrice: 400,
    totalPrice: 3600,
  });
});

test("the pilot rejects quantity other than exactly 1 and noncanonical delivery types before persistence", async () => {
  let creationCalled = false;
  const pilot = makeEnabledPilot({
    createIdempotentOrderFn: async () => { creationCalled = true; return { status: "created", order: {} }; },
  });

  await assert.rejects(
    pilot.createConfirmedOrder({
      phone: "213555000001",
      messageId: "wamid.quantity",
      session: baseSession({ quantity: 2 }),
      product: baseProduct(),
      shippingPrice: 400,
    }),
    /quantity exactly 1/
  );
  await assert.rejects(
    pilot.createConfirmedOrder({
      phone: "213555000001",
      messageId: "wamid.delivery",
      session: baseSession({ delivery_type: "domicile" }),
      product: baseProduct(),
      shippingPrice: 400,
    }),
    /delivery_type/
  );
  assert.equal(creationCalled, false);
});

test("non-allowlisted traffic uses exactly the legacy creation path", async () => {
  let legacyCalls = 0;
  let pilotCalls = 0;
  const pilot = {
    isEligible: () => false,
    async createConfirmedOrder() { pilotCalls++; return {}; },
  };

  const result = await createConfirmedOrderWithPilot({
    pilot,
    phone: "213555000099",
    messageId: "wamid.legacy",
    session: baseSession(),
    product: baseProduct(),
    shippingPrice: 400,
    createLegacyOrderFn: async () => { legacyCalls++; return { id: "LEGACY-1", total: 3600 }; },
  });

  assert.deepEqual(result, { path: "legacy", order: { id: "LEGACY-1", total: 3600 } });
  assert.equal(legacyCalls, 1);
  assert.equal(pilotCalls, 0);
});

test("allowlisted traffic uses exactly the pilot path and passes incoming.id unchanged", async () => {
  const exactMessageId = "wamid.Meta-Opaque-1";
  let receivedMessageId;
  let legacyCalls = 0;
  const pilot = makeEnabledPilot({
    createIdempotentOrderFn: async (_state, messageId) => {
      receivedMessageId = messageId;
      return { status: "created", order: { id: "DL-1", total: 3600 } };
    },
  });

  const result = await createConfirmedOrderWithPilot({
    pilot,
    phone: "213555000001",
    messageId: exactMessageId,
    session: baseSession(),
    product: baseProduct(),
    shippingPrice: 400,
    createLegacyOrderFn: async () => { legacyCalls++; return {}; },
  });

  assert.deepEqual(result, { path: "pilot", order: { id: "DL-1", total: 3600 } });
  assert.equal(receivedMessageId, exactMessageId);
  assert.equal(legacyCalls, 0);
});

test("already_created is a successful pilot result without legacy fallback", async () => {
  let legacyCalls = 0;
  const pilot = makeEnabledPilot({
    createIdempotentOrderFn: async () => ({ status: "already_created", order: { id: "DL-1", total: 3600 } }),
  });
  const result = await createConfirmedOrderWithPilot({
    pilot,
    phone: "213555000001",
    messageId: "wamid.retry",
    session: baseSession(),
    product: baseProduct(),
    shippingPrice: 400,
    createLegacyOrderFn: async () => { legacyCalls++; return {}; },
  });

  assert.equal(result.path, "pilot");
  assert.equal(result.order.id, "DL-1");
  assert.equal(legacyCalls, 0);
});

test("pilot rejection, conflict, and malformed persistence results never fall back to legacy creation", async () => {
  for (const createIdempotentOrderFn of [
    async () => { throw new Error("database unavailable"); },
    async () => ({ status: "idempotency_conflict", patch: {}, conflictingFields: ["phone"] }),
    async () => ({ status: "persistence_read_shape", patch: {} }),
  ]) {
    let legacyCalls = 0;
    const pilot = makeEnabledPilot({ createIdempotentOrderFn });
    await assert.rejects(() => createConfirmedOrderWithPilot({
      pilot,
      phone: "213555000001",
      messageId: "wamid.fail-closed",
      session: baseSession(),
      product: baseProduct(),
      shippingPrice: 400,
      createLegacyOrderFn: async () => { legacyCalls++; return {}; },
    }));
    assert.equal(legacyCalls, 0);
  }
});

test("enabled pilot closes its Pool exactly once", async () => {
  let endCalls = 0;
  const pilot = makeEnabledPilot({
    createPool: () => ({
      async query() { return { rowCount: 1, rows: [] }; },
      async end() { endCalls++; },
    }),
  });

  await pilot.close();
  await pilot.close();
  assert.equal(endCalls, 1);
});

function makePersistencePool() {
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
          projection_attempts: 0,
        };
        rowsByKey.set(idempotencyKey, row);
        rowsById.set(row.id, row);
        return { rowCount: 1, rows: [row] };
      }
      if (sql.includes("SELECT * FROM orders WHERE idempotency_key")) {
        const row = rowsByKey.get(params[0]);
        return { rowCount: row ? 1 : 0, rows: row ? [row] : [] };
      }
      if (sql.includes("projection_status = 'projected'")) {
        rowsById.get(params[0]).projection_status = "projected";
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes("projection_status = 'failed'")) {
        const row = rowsById.get(params[0]);
        row.projection_status = "failed";
        row.projection_attempts++;
        row.last_projection_error = params[1];
        return { rowCount: 1, rows: [] };
      }
      throw new Error(`unexpected fake query: ${sql}`);
    },
    async end() {},
    rowsByKey,
  };
}

async function settleProjection() {
  await new Promise((resolve) => setTimeout(resolve, 20));
}

test("fake end-to-end composition creates one Postgres row and one inline projection for repeated message ID", async () => {
  const pool = makePersistencePool();
  const sheetRows = [];
  const pilot = createSandboxOrderPilot({
    enabled: true,
    phoneAllowlistRaw: "213555000001",
    databaseUrl: "postgresql://fake",
    appSecret: "test-app-secret",
    createPool: () => pool,
    getValuesFn: async () => [[...ORDER_HEADERS], ...sheetRows],
    appendValuesFn: async (_range, values) => { sheetRows.push(...values); },
    ordersTab: "ORDERS",
    logger: { log() {}, warn() {}, error() {} },
  });
  const args = {
    pilot,
    phone: "213555000001",
    messageId: "wamid.composed",
    session: baseSession(),
    product: baseProduct(),
    shippingPrice: 400,
    createLegacyOrderFn: async () => { throw new Error("legacy path must not run"); },
  };

  const first = await createConfirmedOrderWithPilot(args);
  await settleProjection();
  const second = await createConfirmedOrderWithPilot(args);

  assert.equal(first.path, "pilot");
  assert.equal(second.path, "pilot");
  assert.equal(second.order.id, first.order.id);
  assert.equal(pool.rowsByKey.size, 1);
  assert.equal(sheetRows.length, 1);
  assert.equal(sheetRows[0][ORDER_HEADERS.indexOf("message_id")], "wamid.composed");
});

test("inline projection failure keeps the Postgres order authoritative and never invokes legacy creation", async () => {
  const pool = makePersistencePool();
  const pilot = createSandboxOrderPilot({
    enabled: true,
    phoneAllowlistRaw: "213555000001",
    databaseUrl: "postgresql://fake",
    appSecret: "test-app-secret",
    createPool: () => pool,
    getValuesFn: async () => [[...ORDER_HEADERS]],
    appendValuesFn: async () => { throw new Error("fake Sheets outage"); },
    ordersTab: "ORDERS",
    logger: { log() {}, warn() {}, error() {} },
  });
  let legacyCalls = 0;

  const result = await createConfirmedOrderWithPilot({
    pilot,
    phone: "213555000001",
    messageId: "wamid.projection-fails",
    session: baseSession(),
    product: baseProduct(),
    shippingPrice: 400,
    createLegacyOrderFn: async () => { legacyCalls++; return {}; },
  });
  await settleProjection();

  assert.equal(result.path, "pilot");
  assert.equal(pool.rowsByKey.size, 1);
  assert.equal(pool.rowsByKey.get("wamid.projection-fails").projection_status, "failed");
  assert.equal(legacyCalls, 0);
});

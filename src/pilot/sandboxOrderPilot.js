import { createIdempotentOrder } from "../engines/orderEngine.js";
import { createOrderPersistence } from "../persistence/orderPersistence.js";

function requireNonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} is required when the sandbox order pilot is enabled`);
  }
}

export function parseSandboxOrderPilotPhoneAllowlist(raw) {
  if (typeof raw !== "string") {
    throw new TypeError("SANDBOX_ORDER_PILOT_PHONE_ALLOWLIST must be a string");
  }
  if (raw.trim().length === 0) return new Set();

  const phones = raw.split(",").map((phone) => phone.trim());
  if (phones.some((phone) => !/^\d+$/.test(phone))) {
    throw new Error("SANDBOX_ORDER_PILOT_PHONE_ALLOWLIST must contain only comma-separated digit-only phones");
  }
  return new Set(phones);
}

export function buildSandboxPilotOrderState(session, product, shippingPrice) {
  const quantity = session.quantity === undefined || session.quantity === "" ? 1 : Number(session.quantity);
  if (quantity !== 1) {
    throw new Error("Sandbox order pilot supports quantity exactly 1");
  }
  if (session.delivery_type !== "home" && session.delivery_type !== "office") {
    throw new Error("Sandbox order pilot requires delivery_type to be exactly 'home' or 'office'");
  }

  const productPrice = Number(product.price);
  if (!Number.isFinite(productPrice) || productPrice < 0) {
    throw new Error("Sandbox order pilot requires a finite non-negative product price");
  }
  if (typeof shippingPrice !== "number" || !Number.isFinite(shippingPrice) || shippingPrice < 0) {
    throw new Error("Sandbox order pilot requires a finite non-negative shipping price");
  }

  return {
    stage: "confirmed",
    customerName: session.customer_name,
    phone: session.phone,
    wilaya: session.wilaya,
    commune: session.commune,
    deliveryType: session.delivery_type,
    validatedProductId: product.product,
    validatedVariant: {
      color: session.color || product.color,
      size: session.size || product.size,
    },
    productPrice,
    deliveryPrice: shippingPrice,
    totalPrice: productPrice + shippingPrice,
  };
}

function createDisabledPilot() {
  return {
    enabled: false,
    isEligible() { return false; },
    async createConfirmedOrder() {
      throw new Error("Sandbox order pilot is disabled");
    },
    async close() {},
  };
}

export function createSandboxOrderPilot({
  enabled = false,
  phoneAllowlistRaw = "",
  databaseUrl = "",
  appSecret = "",
  createPool,
  getValuesFn,
  appendValuesFn,
  ordersTab,
  logger = console,
  createIdempotentOrderFn = createIdempotentOrder,
  createOrderPersistenceFn = createOrderPersistence,
} = {}) {
  if (enabled !== true) return createDisabledPilot();

  const allowedPhones = parseSandboxOrderPilotPhoneAllowlist(phoneAllowlistRaw);
  if (allowedPhones.size === 0) {
    throw new Error("SANDBOX_ORDER_PILOT_PHONE_ALLOWLIST must be non-empty when the sandbox order pilot is enabled");
  }
  requireNonEmptyString(databaseUrl, "DATABASE_URL");
  requireNonEmptyString(appSecret, "APP_SECRET");
  if (typeof createPool !== "function") {
    throw new TypeError("createSandboxOrderPilot(): createPool must be a function when enabled");
  }

  const pool = createPool({
    connectionString: databaseUrl,
    ssl: { rejectUnauthorized: true },
  });
  if (!pool || typeof pool.query !== "function" || typeof pool.end !== "function") {
    throw new TypeError("createSandboxOrderPilot(): createPool must return a Pool-like object with query() and end()");
  }

  const persistence = createOrderPersistenceFn({
    pool,
    getValuesFn,
    appendValuesFn,
    ordersTab,
    logger,
  });
  if (!persistence || typeof persistence.createOrderRecord !== "function") {
    throw new TypeError("createSandboxOrderPilot(): persistence must expose createOrderRecord()");
  }

  let closePromise;
  const isEligible = (phone) => typeof phone === "string" && allowedPhones.has(phone);

  return {
    enabled: true,
    isEligible,
    async createConfirmedOrder({ phone, messageId, session, product, shippingPrice }) {
      if (!isEligible(phone)) {
        throw new Error("Sandbox order pilot phone is not allowlisted");
      }
      if (typeof messageId !== "string" || messageId.trim().length === 0) {
        throw new Error("Sandbox order pilot requires the unchanged Meta message ID");
      }

      const orderState = buildSandboxPilotOrderState(session, product, shippingPrice);
      const result = await createIdempotentOrderFn(orderState, messageId, {
        createOrderRecord: persistence.createOrderRecord,
      });

      if (result.status === "created" || result.status === "already_created") {
        return result.order;
      }
      throw new Error(`Sandbox order pilot failed closed with status '${result.status}'`);
    },
    async close() {
      if (!closePromise) closePromise = Promise.resolve().then(() => pool.end());
      return closePromise;
    },
  };
}

export async function createConfirmedOrderWithPilot({
  pilot,
  phone,
  messageId,
  session,
  product,
  shippingPrice,
  createLegacyOrderFn,
}) {
  if (!pilot || typeof pilot.isEligible !== "function" || typeof pilot.createConfirmedOrder !== "function") {
    throw new TypeError("createConfirmedOrderWithPilot(): pilot is invalid");
  }

  if (!pilot.isEligible(phone)) {
    if (typeof createLegacyOrderFn !== "function") {
      throw new TypeError("createConfirmedOrderWithPilot(): createLegacyOrderFn must be a function");
    }
    return {
      path: "legacy",
      order: await createLegacyOrderFn(session, product, shippingPrice),
    };
  }

  return {
    path: "pilot",
    order: await pilot.createConfirmedOrder({ phone, messageId, session, product, shippingPrice }),
  };
}

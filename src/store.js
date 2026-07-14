import { cfg } from "./config.js";
import { getValues, updateValues, appendValues, ensureTab } from "./sheetsClient.js";
import { normalize, pick, toNumber, colLetter, editDistanceWithin } from "./utils.js";

const PRODUCT_CACHE_TTL_MS = 20_000;
const SHIPPING_CACHE_TTL_MS = 20_000;

export const ORDER_HEADERS = [
  "created_at","order_id","customer_name","phone","wilaya","commune","delivery_type",
  "product","color","size","quantity","unit_price","shipping_price","total","status","source","notes",
];

// "history" is a new trailing column - ensureTab() will add it to an
// existing SESSIONS sheet without disturbing the columns already there.
export const SESSION_HEADERS = [
  "phone","updated_at","stage","customer_name","wilaya","commune","delivery_type",
  "product","color","size","quantity","last_message","history",
];

export async function initStore() {
  await ensureTab(cfg.sheets.orders, ORDER_HEADERS);
  await ensureTab(cfg.sheets.sessions, SESSION_HEADERS);
}

// ---------------------------------------------------------------------------
// Products (owner-managed sheet - headers can be in French/English/Arabic,
// hence the alias-based lookup instead of fixed columns).
// ---------------------------------------------------------------------------

function mapAliasedRow(headers, row) {
  return Object.fromEntries(headers.map((h, i) => [normalize(h), row[i] ?? ""]));
}

async function readAliasedRows(tab, ttlMs) {
  const values = await getValues(`'${tab}'!A:ZZ`, { ttlMs });
  if (values.length < 2) return [];
  return values.slice(1).filter((row) => row.some((cell) => String(cell).trim())).map((row) => mapAliasedRow(values[0], row));
}

export async function getAllProducts() {
  const rows = await readAliasedRows(cfg.sheets.products, PRODUCT_CACHE_TTL_MS);
  return rows.map((r) => ({
    product: pick(r, "product"),
    color: pick(r, "color"),
    size: pick(r, "size"),
    price: toNumber(pick(r, "price")),
    stock: toNumber(pick(r, "stock")),
    image: pick(r, "image"),
    description: pick(r, "description"),
  }));
}

// Scored, tolerant search: a product no longer needs every query token to
// literally appear as a substring somewhere in the row. It needs at least
// half of the tokens to match (exact substring, or a 1-edit-distance fuzzy
// match against a whole word) and results are ranked by match quality, not
// sheet row order.
function scoreProduct(product, tokens) {
  const haystacks = [product.product, product.color, product.size, product.description].map(normalize).filter(Boolean);
  let score = 0;
  let matched = 0;
  for (const token of tokens) {
    let best = 0;
    for (const h of haystacks) {
      if (h.includes(token)) { best = 2; break; }
      if (best < 1 && token.length >= 3 && h.split(" ").some((w) => w.length >= 3 && editDistanceWithin(w, token, 1))) best = 1;
    }
    if (best > 0) { matched++; score += best; }
  }
  return { score, matched };
}

export async function searchProducts(query) {
  const tokens = normalize(query).split(" ").filter(Boolean);
  const inStock = (await getAllProducts()).filter((p) => p.stock > 0);
  if (tokens.length === 0) return inStock.slice(0, 8);

  const needed = Math.max(1, Math.ceil(tokens.length / 2));
  return inStock
    .map((p) => ({ p, ...scoreProduct(p, tokens) }))
    .filter((x) => x.matched >= needed)
    .sort((a, b) => b.score - a.score || b.p.stock - a.p.stock)
    .slice(0, 8)
    .map((x) => x.p);
}

// ---------------------------------------------------------------------------
// Shipping (owner-managed sheet, same alias approach as products).
// ---------------------------------------------------------------------------

export async function getShippingRate(wilaya, commune, deliveryType) {
  const w = normalize(wilaya);
  if (!w) return { home: 0, office: 0, selected: null, matched: false };

  const rows = await readAliasedRows(cfg.sheets.shipping, SHIPPING_CACHE_TTL_MS);
  const c = normalize(commune);
  const exact = c && rows.find((r) => normalize(pick(r, "wilaya")) === w && normalize(pick(r, "commune")) === c);
  const row = exact || rows.find((r) => normalize(pick(r, "wilaya")) === w);
  if (!row) return { home: 0, office: 0, selected: null, matched: false };

  const home = toNumber(pick(row, "home"));
  const office = toNumber(pick(row, "office"));
  let selected = null;
  if (/office|bureau|maktab|مكتب/i.test(deliveryType || "")) selected = office;
  else if (/home|domicile|منزل|بيت/i.test(deliveryType || "")) selected = home;
  return { home, office, selected, matched: true };
}

// ---------------------------------------------------------------------------
// Sessions (bot-owned sheet). Read/write by exact header text rather than
// the normalize()-based alias lookup used for products/shipping: the old
// code called mapRow() (which keys by normalize(header)) but then read
// fields like `m.customer_name` - normalize("customer_name") actually
// produces "customer name" (underscore -> space), so customer_name,
// delivery_type and last_message never round-tripped from a saved session.
// Using the literal header text as the key sidesteps that mismatch entirely.
// ---------------------------------------------------------------------------

function emptySession(phone) {
  return { phone, stage: "browsing", quantity: 1, history: [] };
}

function isStale(session) {
  if (!session.updated_at) return false;
  const ageMs = Date.now() - new Date(session.updated_at).getTime();
  return Number.isFinite(ageMs) && ageMs > cfg.sessionTtlHours * 3_600_000;
}

// Clears the product-specific part of a session (used after an order is
// placed, and for sessions that have gone stale) while keeping the
// reusable customer profile (name/wilaya/commune) intact.
export function resetProductContext(session) {
  session.product = "";
  session.color = "";
  session.size = "";
  session.quantity = 1;
  session.delivery_type = "";
  session.stage = "browsing";
  session.history = [];
}

export async function getSession(phone) {
  const values = await getValues(`'${cfg.sheets.sessions}'!A:ZZ`);
  if (values.length < 2) return emptySession(phone);

  const headers = values[0];
  const idx = Object.fromEntries(headers.map((h, i) => [h, i]));

  for (let i = values.length - 1; i >= 1; i--) {
    const row = values[i];
    if (String(row[idx.phone] ?? "") !== String(phone)) continue;

    const get = (h) => (idx[h] !== undefined ? row[idx[h]] ?? "" : "");
    let history = [];
    try { history = JSON.parse(get("history") || "[]"); } catch { history = []; }
    if (!Array.isArray(history)) history = [];

    const session = {
      phone,
      rowNumber: i + 1,
      updated_at: get("updated_at") || "",
      stage: get("stage") || "browsing",
      customer_name: get("customer_name") || "",
      wilaya: get("wilaya") || "",
      commune: get("commune") || "",
      delivery_type: get("delivery_type") || "",
      product: get("product") || "",
      color: get("color") || "",
      size: get("size") || "",
      quantity: Number(get("quantity")) || 1,
      last_message: get("last_message") || "",
      history,
    };

    // A conversation that went quiet for a long time shouldn't inherit the
    // previous product/order context into what is effectively a new chat.
    if (isStale(session)) resetProductContext(session);
    return session;
  }

  return emptySession(phone);
}

export async function saveSession(session) {
  const row = SESSION_HEADERS.map((h) => {
    if (h === "updated_at") return new Date().toISOString();
    if (h === "history") return JSON.stringify(session.history || []);
    if (h === "quantity") return session.quantity || 1;
    return session[h] ?? "";
  });
  const endCol = colLetter(SESSION_HEADERS.length);
  if (session.rowNumber) {
    await updateValues(`'${cfg.sheets.sessions}'!A${session.rowNumber}:${endCol}${session.rowNumber}`, [row]);
  } else {
    await appendValues(`'${cfg.sheets.sessions}'!A:${endCol}`, [row]);
  }
}

// ---------------------------------------------------------------------------
// Orders (bot-owned, append-only).
// ---------------------------------------------------------------------------

export async function createOrder(session, product, shippingPrice) {
  const quantity = Number(session.quantity) || 1;
  const id = `DL-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
  const total = product.price * quantity + shippingPrice;
  const row = [
    new Date().toISOString(), id, session.customer_name, session.phone, session.wilaya, session.commune,
    session.delivery_type, product.product, session.color || product.color, session.size || product.size,
    quantity, product.price, shippingPrice, total, "NEW", "WhatsApp Bot", "",
  ];
  await appendValues(`'${cfg.sheets.orders}'!A:${colLetter(ORDER_HEADERS.length)}`, [row]);
  return { id, total };
}

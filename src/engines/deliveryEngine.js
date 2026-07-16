// Delivery Engine - Fresh Read boundary required by Order Engine
// (confirmGroundedOrder()'s injected deps.getFreshDeliveryQuote).
//
// createGetFreshDeliveryQuote({ getValuesFn }) returns
// getFreshDeliveryQuote(wilaya, commune, deliveryType), which performs a
// Fresh Read of the SHIPPING tab only (ttlMs: 0, no cache) on every call -
// no cache of its own. No default, network-capable dependency: getValuesFn
// must be injected. Standalone, unwired code - nothing calls this yet.
//
// Deliberately does not import from orderEngine.js (even though the range-
// building / row-mapping logic below is the same shape as its
// freshReadRows()): the two engines must stay independently importable.
// The row-mapping algorithm mirrors store.js's readAliasedRows()/mapRow()
// (normalize()-based header keys, empty-row filtering), reusing only
// src/utils.js's normalize()/pick()/toNumber() - this file does not modify
// utils.js.
//
// The price whitelist (isWellFormedPriceCell below) is intentionally
// identical to Order Engine's: plain digits; comma decimal (1-2 trailing
// digits); a single comma-thousands group (exactly 3 trailing digits); dot
// decimal (1-2 trailing digits). A dot with 3+ trailing digits (e.g.
// "1.200") is rejected before toNumber() ever sees it, since toNumber() has
// no disambiguation branch for a lone dot and would otherwise parse it as
// 1.2.

import { normalize, pick, toNumber } from "../utils.js";

function escapeSheetName(tab) {
  return tab.replace(/'/g, "''");
}

function buildRange(tab) {
  return `'${escapeSheetName(tab)}'!A:ZZ`;
}

function mapAliasedRow(headers, row) {
  return Object.fromEntries(headers.map((h, i) => [normalize(h), row[i] ?? ""]));
}

async function freshReadShippingRows(getValuesFn) {
  const range = buildRange("SHIPPING");
  const values = await getValuesFn(range, { ttlMs: 0 });

  if (values.length < 2) return [];

  return values
    .slice(1)
    .filter((row) => row.some((cell) => String(cell).trim()))
    .map((row) => mapAliasedRow(values[0], row));
}

function isWellFormedPriceCell(rawValue) {
  const s = String(rawValue ?? "").trim();
  if (s === "") return false;
  if (/^\d+$/.test(s)) return true;
  if (/^\d+,\d{1,2}$/.test(s)) return true;
  if (/^\d+,\d{3}$/.test(s)) return true;
  if (/^\d+\.\d{1,2}$/.test(s)) return true;
  return false;
}

function parsePrice(rawValue) {
  if (!isWellFormedPriceCell(rawValue)) return { valid: false };
  const n = toNumber(rawValue);
  if (!Number.isFinite(n) || n < 0) return { valid: false };
  return { valid: true, value: n };
}

function assertGetFreshDeliveryQuoteInputs(wilaya, commune, deliveryType) {
  if (typeof wilaya !== "string") {
    throw new TypeError("getFreshDeliveryQuote(): wilaya must be a string");
  }
  if (wilaya.trim().length === 0) {
    throw new RangeError("getFreshDeliveryQuote(): wilaya must be non-empty (whitespace-only is treated as empty)");
  }
  if (typeof commune !== "string") {
    throw new TypeError("getFreshDeliveryQuote(): commune must be a string");
  }
  if (commune.trim().length === 0) {
    throw new RangeError("getFreshDeliveryQuote(): commune must be non-empty (whitespace-only is treated as empty)");
  }
  if (typeof deliveryType !== "string") {
    throw new TypeError("getFreshDeliveryQuote(): deliveryType must be a string");
  }
  if (deliveryType !== "home" && deliveryType !== "office") {
    throw new RangeError("getFreshDeliveryQuote(): deliveryType must be 'home' or 'office'");
  }
}

function findQuoteRow(rows, wilaya, commune) {
  const wantedWilaya = normalize(wilaya);
  const wilayaRows = rows.filter((row) => normalize(pick(row, "wilaya")) === wantedWilaya);
  if (wilayaRows.length === 0) return null;

  const wantedCommune = normalize(commune);
  const exactRow = wilayaRows.find((row) => normalize(pick(row, "commune")) === wantedCommune);
  if (exactRow) return exactRow;

  if (wilayaRows.length === 1) return wilayaRows[0];

  return null;
}

export function createGetFreshDeliveryQuote(deps = {}) {
  if (deps === null || typeof deps !== "object") {
    throw new TypeError("createGetFreshDeliveryQuote(): deps must be a non-null object");
  }
  const { getValuesFn } = deps;
  if (typeof getValuesFn !== "function") {
    throw new TypeError(
      "createGetFreshDeliveryQuote(): deps.getValuesFn must be a function - no default implementation exists."
    );
  }

  return async function getFreshDeliveryQuote(wilaya, commune, deliveryType) {
    assertGetFreshDeliveryQuoteInputs(wilaya, commune, deliveryType);

    const rows = await freshReadShippingRows(getValuesFn);
    const row = findQuoteRow(rows, wilaya, commune);
    if (!row) return { price: null, matched: false };

    const rawPrice = deliveryType === "office" ? pick(row, "office") : pick(row, "home");
    const parsed = parsePrice(rawPrice);
    if (!parsed.valid) return { price: null, matched: true };

    return { price: parsed.value, matched: true };
  };
}

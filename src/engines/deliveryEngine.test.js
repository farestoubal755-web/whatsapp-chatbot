// Tests for the Delivery Engine's Fresh Read boundary
// (createGetFreshDeliveryQuote() / getFreshDeliveryQuote()).
// Run with: node --test src/engines/deliveryEngine.test.js
//
// No live Google Sheets call anywhere in this file - getValuesFn is always
// a fake, injected function.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createGetFreshDeliveryQuote } from "./deliveryEngine.js";

const SHIPPING_HEADERS = ["Wilaya", "Commune", "Home", "Office"];

function shippingSheet(rows) {
  return [SHIPPING_HEADERS, ...rows];
}

function fakeGetValuesFn(rows) {
  return async () => shippingSheet(rows);
}

function countingGetValuesFn(rows) {
  const fn = fakeGetValuesFn(rows);
  const wrapped = async (...args) => {
    wrapped.calls++;
    return fn(...args);
  };
  wrapped.calls = 0;
  return wrapped;
}

// --- Factory preconditions (before any read) ---

test("createGetFreshDeliveryQuote() throws TypeError if deps is omitted, null, or not an object", () => {
  assert.throws(() => createGetFreshDeliveryQuote(), TypeError);
  assert.throws(() => createGetFreshDeliveryQuote(null), TypeError);
  assert.throws(() => createGetFreshDeliveryQuote("not an object"), TypeError);
});

test("createGetFreshDeliveryQuote() throws TypeError if deps.getValuesFn is missing or not a function", () => {
  assert.throws(() => createGetFreshDeliveryQuote({}), TypeError);
  assert.throws(() => createGetFreshDeliveryQuote({ getValuesFn: "nope" }), TypeError);
});

// --- getFreshDeliveryQuote() input preconditions (before any read) ---

test("getFreshDeliveryQuote() throws for wilaya: wrong type -> TypeError, empty/whitespace -> RangeError, and never reads", async () => {
  const getValuesFn = countingGetValuesFn([]);
  const getFreshDeliveryQuote = createGetFreshDeliveryQuote({ getValuesFn });

  await assert.rejects(() => getFreshDeliveryQuote(16, "Bab El Oued", "home"), TypeError);
  await assert.rejects(() => getFreshDeliveryQuote("", "Bab El Oued", "home"), RangeError);
  await assert.rejects(() => getFreshDeliveryQuote("   ", "Bab El Oued", "home"), RangeError);
  assert.equal(getValuesFn.calls, 0, "getValuesFn must not be called on a precondition failure");
});

test("getFreshDeliveryQuote() throws for commune: wrong type -> TypeError, empty/whitespace -> RangeError, and never reads", async () => {
  const getValuesFn = countingGetValuesFn([]);
  const getFreshDeliveryQuote = createGetFreshDeliveryQuote({ getValuesFn });

  await assert.rejects(() => getFreshDeliveryQuote("Alger", 16, "home"), TypeError);
  await assert.rejects(() => getFreshDeliveryQuote("Alger", "", "home"), RangeError);
  await assert.rejects(() => getFreshDeliveryQuote("Alger", "   ", "home"), RangeError);
  assert.equal(getValuesFn.calls, 0, "getValuesFn must not be called on a precondition failure");
});

test("getFreshDeliveryQuote() throws for deliveryType: wrong type -> TypeError, invalid value -> RangeError, and never reads", async () => {
  const getValuesFn = countingGetValuesFn([]);
  const getFreshDeliveryQuote = createGetFreshDeliveryQuote({ getValuesFn });

  await assert.rejects(() => getFreshDeliveryQuote("Alger", "Bab El Oued", 1), TypeError);
  await assert.rejects(() => getFreshDeliveryQuote("Alger", "Bab El Oued", "express"), RangeError);
  assert.equal(getValuesFn.calls, 0, "getValuesFn must not be called on a precondition failure");
});

// --- Fresh Read behavior ---

test("getFreshDeliveryQuote() always calls getValuesFn with { ttlMs: 0 }, proving no cache", async () => {
  let capturedOptions;
  const getValuesFn = async (range, options) => {
    capturedOptions = options;
    return shippingSheet([["Alger", "Bab El Oued", "400", "300"]]);
  };
  const getFreshDeliveryQuote = createGetFreshDeliveryQuote({ getValuesFn });
  await getFreshDeliveryQuote("Alger", "Bab El Oued", "home");
  assert.deepEqual(capturedOptions, { ttlMs: 0 });
});

test("getFreshDeliveryQuote() reads the exact quoted A1 range for SHIPPING", async () => {
  let capturedRange;
  const getValuesFn = async (range) => {
    capturedRange = range;
    return shippingSheet([["Alger", "Bab El Oued", "400", "300"]]);
  };
  const getFreshDeliveryQuote = createGetFreshDeliveryQuote({ getValuesFn });
  await getFreshDeliveryQuote("Alger", "Bab El Oued", "home");
  assert.equal(capturedRange, "'SHIPPING'!A:ZZ");
});

test("getFreshDeliveryQuote() calls getValuesFn exactly once per call", async () => {
  const getValuesFn = countingGetValuesFn([["Alger", "Bab El Oued", "400", "300"]]);
  const getFreshDeliveryQuote = createGetFreshDeliveryQuote({ getValuesFn });
  await getFreshDeliveryQuote("Alger", "Bab El Oued", "home");
  assert.equal(getValuesFn.calls, 1);
});

// --- Exact matching, home and office ---

test("getFreshDeliveryQuote() returns the home price on an exact wilaya+commune match with deliveryType 'home'", async () => {
  const getValuesFn = fakeGetValuesFn([["Alger", "Bab El Oued", "400", "300"]]);
  const getFreshDeliveryQuote = createGetFreshDeliveryQuote({ getValuesFn });
  const result = await getFreshDeliveryQuote("Alger", "Bab El Oued", "home");
  assert.deepEqual(result, { price: 400, matched: true });
});

test("getFreshDeliveryQuote() returns the office price on an exact wilaya+commune match with deliveryType 'office'", async () => {
  const getValuesFn = fakeGetValuesFn([["Alger", "Bab El Oued", "400", "300"]]);
  const getFreshDeliveryQuote = createGetFreshDeliveryQuote({ getValuesFn });
  const result = await getFreshDeliveryQuote("Alger", "Bab El Oued", "office");
  assert.deepEqual(result, { price: 300, matched: true });
});

// --- Row selection among multiple wilaya rows ---

test("getFreshDeliveryQuote() prefers the exact commune row when multiple rows share the same wilaya", async () => {
  const getValuesFn = fakeGetValuesFn([
    ["Alger", "Bab El Oued", "400", "300"],
    ["Alger", "Hydra", "500", "350"],
  ]);
  const getFreshDeliveryQuote = createGetFreshDeliveryQuote({ getValuesFn });
  const result = await getFreshDeliveryQuote("Alger", "Hydra", "home");
  assert.deepEqual(result, { price: 500, matched: true });
});

test("getFreshDeliveryQuote() falls back to the single row for a wilaya when commune doesn't match exactly", async () => {
  const getValuesFn = fakeGetValuesFn([["Alger", "Bab El Oued", "400", "300"]]);
  const getFreshDeliveryQuote = createGetFreshDeliveryQuote({ getValuesFn });
  const result = await getFreshDeliveryQuote("Alger", "Some Other Commune", "home");
  assert.deepEqual(result, { price: 400, matched: true });
});

test("getFreshDeliveryQuote() returns unmatched when multiple wilaya rows exist and none has an exact commune match", async () => {
  const getValuesFn = fakeGetValuesFn([
    ["Alger", "Bab El Oued", "400", "300"],
    ["Alger", "Hydra", "500", "350"],
  ]);
  const getFreshDeliveryQuote = createGetFreshDeliveryQuote({ getValuesFn });
  const result = await getFreshDeliveryQuote("Alger", "Some Other Commune", "home");
  assert.deepEqual(result, { price: null, matched: false });
});

test("getFreshDeliveryQuote() never selects an arbitrary first row among ambiguous wilaya rows", async () => {
  const getValuesFn = fakeGetValuesFn([
    ["Alger", "Hydra", "999", "999"],
    ["Alger", "El Biar", "111", "111"],
  ]);
  const getFreshDeliveryQuote = createGetFreshDeliveryQuote({ getValuesFn });
  const result = await getFreshDeliveryQuote("Alger", "Not Listed", "home");
  assert.deepEqual(result, { price: null, matched: false });
});

test("getFreshDeliveryQuote() returns unmatched when no row has the requested wilaya", async () => {
  const getValuesFn = fakeGetValuesFn([["Oran", "Es Senia", "400", "300"]]);
  const getFreshDeliveryQuote = createGetFreshDeliveryQuote({ getValuesFn });
  const result = await getFreshDeliveryQuote("Alger", "Bab El Oued", "home");
  assert.deepEqual(result, { price: null, matched: false });
});

test("getFreshDeliveryQuote() never fuzzy-matches a merely similar wilaya name", async () => {
  const getValuesFn = fakeGetValuesFn([["Algerie", "Bab El Oued", "400", "300"]]);
  const getFreshDeliveryQuote = createGetFreshDeliveryQuote({ getValuesFn });
  const result = await getFreshDeliveryQuote("Alger", "Bab El Oued", "home");
  assert.deepEqual(result, { price: null, matched: false });
});

// --- Matched row with invalid price ---

test("getFreshDeliveryQuote() returns matched:true, price:null when the matched row's price is malformed", async () => {
  const getValuesFn = fakeGetValuesFn([["Alger", "Bab El Oued", "abc", "300"]]);
  const getFreshDeliveryQuote = createGetFreshDeliveryQuote({ getValuesFn });
  const result = await getFreshDeliveryQuote("Alger", "Bab El Oued", "home");
  assert.deepEqual(result, { price: null, matched: true });
});

test("getFreshDeliveryQuote() returns matched:true, price:null when the matched row's price is negative", async () => {
  const getValuesFn = fakeGetValuesFn([["Alger", "Bab El Oued", "-500", "300"]]);
  const getFreshDeliveryQuote = createGetFreshDeliveryQuote({ getValuesFn });
  const result = await getFreshDeliveryQuote("Alger", "Bab El Oued", "home");
  assert.deepEqual(result, { price: null, matched: true });
});

test("getFreshDeliveryQuote() returns matched:true, price:null when the matched row's price is empty", async () => {
  const getValuesFn = fakeGetValuesFn([["Alger", "Bab El Oued", "", "300"]]);
  const getFreshDeliveryQuote = createGetFreshDeliveryQuote({ getValuesFn });
  const result = await getFreshDeliveryQuote("Alger", "Bab El Oued", "home");
  assert.deepEqual(result, { price: null, matched: true });
});

// --- Price whitelist ---

test("getFreshDeliveryQuote() accepts '12.50' as a valid dot-decimal price", async () => {
  const getValuesFn = fakeGetValuesFn([["Alger", "Bab El Oued", "12.50", "300"]]);
  const getFreshDeliveryQuote = createGetFreshDeliveryQuote({ getValuesFn });
  const result = await getFreshDeliveryQuote("Alger", "Bab El Oued", "home");
  assert.deepEqual(result, { price: 12.5, matched: true });
});

test("getFreshDeliveryQuote() accepts '1200,50' as a valid comma-decimal price", async () => {
  const getValuesFn = fakeGetValuesFn([["Alger", "Bab El Oued", "1200,50", "300"]]);
  const getFreshDeliveryQuote = createGetFreshDeliveryQuote({ getValuesFn });
  const result = await getFreshDeliveryQuote("Alger", "Bab El Oued", "home");
  assert.deepEqual(result, { price: 1200.5, matched: true });
});

test("getFreshDeliveryQuote() accepts '1,200' as a valid comma-thousands price", async () => {
  const getValuesFn = fakeGetValuesFn([["Alger", "Bab El Oued", "1,200", "300"]]);
  const getFreshDeliveryQuote = createGetFreshDeliveryQuote({ getValuesFn });
  const result = await getFreshDeliveryQuote("Alger", "Bab El Oued", "home");
  assert.deepEqual(result, { price: 1200, matched: true });
});

test("getFreshDeliveryQuote() never parses '1.200' as 1.2 - rejects it as matched:true, price:null", async () => {
  const getValuesFn = fakeGetValuesFn([["Alger", "Bab El Oued", "1.200", "300"]]);
  const getFreshDeliveryQuote = createGetFreshDeliveryQuote({ getValuesFn });
  const result = await getFreshDeliveryQuote("Alger", "Bab El Oued", "home");
  assert.deepEqual(result, { price: null, matched: true });
});

const MALFORMED_PRICE_CELLS = ["1..2", "1,,2", "1,2,3", "1.200,50", "1.2000", "1,2000", "abc1xyz", "-500"];

for (const cell of MALFORMED_PRICE_CELLS) {
  test(`getFreshDeliveryQuote() rejects malformed price cell '${cell}' as matched:true, price:null`, async () => {
    const getValuesFn = fakeGetValuesFn([["Alger", "Bab El Oued", cell, "300"]]);
    const getFreshDeliveryQuote = createGetFreshDeliveryQuote({ getValuesFn });
    const result = await getFreshDeliveryQuote("Alger", "Bab El Oued", "home");
    assert.deepEqual(result, { price: null, matched: true });
  });
}

// --- Technical failure propagation ---

test("getFreshDeliveryQuote() propagates a technical rejection from getValuesFn unchanged", async () => {
  const getValuesFn = async () => {
    throw new Error("Sheets API timeout");
  };
  const getFreshDeliveryQuote = createGetFreshDeliveryQuote({ getValuesFn });
  await assert.rejects(() => getFreshDeliveryQuote("Alger", "Bab El Oued", "home"), /Sheets API timeout/);
});

// --- Structural check: no forbidden imports ---

test("deliveryEngine.js does not import from orderEngine.js, store.js, sheetsClient.js, router/, orchestration/, or reply/", () => {
  const filePath = fileURLToPath(new URL("./deliveryEngine.js", import.meta.url));
  const source = readFileSync(filePath, "utf8");
  assert.ok(!/from\s+["'][^"']*orderEngine\.js["']/.test(source), "must not import orderEngine.js");
  assert.ok(!/from\s+["'][^"']*store\.js["']/.test(source), "must not import store.js");
  assert.ok(!/from\s+["'][^"']*sheetsClient\.js["']/.test(source), "must not import sheetsClient.js");
  assert.ok(!/from\s+["'][^"']*\/(router|orchestration|reply)\//.test(source), "must not import from router/, orchestration/, or reply/");
});

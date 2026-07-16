// Tests for the Order Engine: Fresh Read foundation (Sprint 3 Task 0) and
// Order Stage state machine (Sprint 3 Task 1).
// Run with: node --test src/engines/orderEngine.test.js
//
// No live Google Sheets call anywhere in this file - getValuesFn is always
// a fake, injected function. The Task 0 tests below prove freshReadRows()'s
// own calling behavior and row-mapping logic; they do NOT prove anything
// about the real sheetsClient.js/Google Sheets API. That distinction is
// documented in orderEngine.js and the Task 0 implementation report.
//
// The Task 1 tests (Order Stage state machine section, below) need no
// fakes/injection at all - ORDER_STAGES, isValidOrderStage(),
// canTransitionOrderStage(), and transitionOrderStage() are pure and
// synchronous.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  freshReadRows,
  ORDER_STAGES,
  isValidOrderStage,
  canTransitionOrderStage,
  transitionOrderStage,
  confirmGroundedOrder,
  createIdempotentOrder,
} from "./orderEngine.js";

// --- Dependency injection / input validation ---

test("freshReadRows() throws immediately if tab name is missing or empty", async () => {
  await assert.rejects(() => freshReadRows("", { getValuesFn: async () => [] }), /non-empty tab name/);
  await assert.rejects(() => freshReadRows(undefined, { getValuesFn: async () => [] }), /non-empty tab name/);
  await assert.rejects(() => freshReadRows(123, { getValuesFn: async () => [] }), /non-empty tab name/);
});

test("freshReadRows() throws immediately if getValuesFn is missing", async () => {
  await assert.rejects(() => freshReadRows("PRODUCTS 1", {}), /requires an injected getValuesFn/);
});

test("freshReadRows() throws immediately if getValuesFn is not a function", async () => {
  await assert.rejects(() => freshReadRows("PRODUCTS 1", { getValuesFn: "nope" }), /requires an injected getValuesFn/);
});

// --- Freshness: always requests ttlMs: 0 ---

test("freshReadRows() always calls getValuesFn with { ttlMs: 0 }, proving nothing else is requested", async () => {
  let capturedOptions;
  const fakeGetValuesFn = async (range, options) => {
    capturedOptions = options;
    return [["Product", "Color"], ["Fella", "Noir"]];
  };
  await freshReadRows("PRODUCTS 1", { getValuesFn: fakeGetValuesFn });
  assert.deepEqual(capturedOptions, { ttlMs: 0 });
});

// --- A1 range construction ---

test("freshReadRows() constructs the range as '<tab>'!A:ZZ", async () => {
  let capturedRange;
  const fakeGetValuesFn = async (range) => {
    capturedRange = range;
    return [["A"], ["x"]];
  };
  await freshReadRows("PRODUCTS 1", { getValuesFn: fakeGetValuesFn });
  assert.equal(capturedRange, "'PRODUCTS 1'!A:ZZ");
});

test("freshReadRows() escapes an embedded apostrophe in the tab name by doubling it", async () => {
  let capturedRange;
  const fakeGetValuesFn = async (range) => {
    capturedRange = range;
    return [["A"], ["x"]];
  };
  await freshReadRows("L'Orient", { getValuesFn: fakeGetValuesFn });
  assert.equal(capturedRange, "'L''Orient'!A:ZZ");
});

// --- Row-mapping algorithm (compared directly against store.js's behavior) ---

test("maps rows using normalized headers as object keys", async () => {
  const fakeGetValuesFn = async () => [["Product Name", "Couleur"], ["Fella", "Noir"]];
  const rows = await freshReadRows("PRODUCTS 1", { getValuesFn: fakeGetValuesFn });
  assert.deepEqual(rows, [{ "product name": "Fella", couleur: "Noir" }]);
});

test("missing trailing cells in a data row default to empty string", async () => {
  const fakeGetValuesFn = async () => [["Product", "Color", "Size"], ["Fella"]];
  const rows = await freshReadRows("PRODUCTS 1", { getValuesFn: fakeGetValuesFn });
  assert.deepEqual(rows, [{ product: "Fella", color: "", size: "" }]);
});

test("extra cells beyond the header row's width are silently ignored", async () => {
  const fakeGetValuesFn = async () => [["Product"], ["Fella", "Noir", "38"]];
  const rows = await freshReadRows("PRODUCTS 1", { getValuesFn: fakeGetValuesFn });
  assert.deepEqual(rows, [{ product: "Fella" }]);
});

test("an empty header cell normalizes to an empty-string key", async () => {
  const fakeGetValuesFn = async () => [["Product", ""], ["Fella", "extra"]];
  const rows = await freshReadRows("PRODUCTS 1", { getValuesFn: fakeGetValuesFn });
  assert.deepEqual(rows, [{ product: "Fella", "": "extra" }]);
});

test("duplicate normalized headers: the last occurrence's value wins, matching store.js's Object.fromEntries behavior", async () => {
  const fakeGetValuesFn = async () => [["Color", "COLOR"], ["Noir", "Rouge"]];
  const rows = await freshReadRows("PRODUCTS 1", { getValuesFn: fakeGetValuesFn });
  assert.deepEqual(rows, [{ color: "Rouge" }]);
});

test("rows with every cell empty or whitespace are filtered out", async () => {
  const fakeGetValuesFn = async () => [
    ["A", "B"],
    ["", "  "],
    ["x", "y"],
  ];
  const rows = await freshReadRows("T", { getValuesFn: fakeGetValuesFn });
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], { a: "x", b: "y" });
});

test("a row with at least one non-empty cell is kept", async () => {
  const fakeGetValuesFn = async () => [
    ["A", "B"],
    ["", "y"],
  ];
  const rows = await freshReadRows("T", { getValuesFn: fakeGetValuesFn });
  assert.deepEqual(rows, [{ a: "", b: "y" }]);
});

test("returns an empty array when the sheet has a header row but no data rows", async () => {
  const fakeGetValuesFn = async () => [["A", "B"]];
  const rows = await freshReadRows("T", { getValuesFn: fakeGetValuesFn });
  assert.deepEqual(rows, []);
});

test("returns an empty array when the sheet returns no rows at all", async () => {
  const fakeGetValuesFn = async () => [];
  const rows = await freshReadRows("T", { getValuesFn: fakeGetValuesFn });
  assert.deepEqual(rows, []);
});

// --- Order Stage state machine (Sprint 3 Task 1) ---
//
// LEGAL_PAIRS/ILLEGAL_PAIRS are derived from the live ORDER_STAGES export
// rather than hand-copied, so a future change to ORDER_STAGES changes what
// these tests check without anyone editing this file.

const ALL_PAIRS = ORDER_STAGES.flatMap((fromStage) =>
  ORDER_STAGES.map((toStage) => ({ fromStage, toStage }))
);
const LEGAL_PAIRS = ALL_PAIRS.filter(({ fromStage, toStage }) => {
  const delta = ORDER_STAGES.indexOf(toStage) - ORDER_STAGES.indexOf(fromStage);
  return delta === 0 || delta === 1;
});
const ILLEGAL_PAIRS = ALL_PAIRS.filter((pair) => !LEGAL_PAIRS.includes(pair));

// --- ORDER_STAGES ---

test("ORDER_STAGES is a frozen array", () => {
  assert.ok(Object.isFrozen(ORDER_STAGES));
  assert.ok(Array.isArray(ORDER_STAGES));
});

test("ORDER_STAGES contains exactly the 5 expected stage names, in order", () => {
  assert.deepEqual(ORDER_STAGES, [
    "none",
    "collecting_info",
    "awaiting_confirmation",
    "confirmed",
    "created",
  ]);
});

// --- isValidOrderStage() ---

test("isValidOrderStage() returns true for each known stage", () => {
  for (const stage of ORDER_STAGES) {
    assert.equal(isValidOrderStage(stage), true);
  }
});

test("isValidOrderStage() returns false for an unknown string", () => {
  assert.equal(isValidOrderStage("shipped"), false);
});

test("isValidOrderStage() returns false for undefined, null, a number, an object, and an empty string", () => {
  assert.equal(isValidOrderStage(undefined), false);
  assert.equal(isValidOrderStage(null), false);
  assert.equal(isValidOrderStage(42), false);
  assert.equal(isValidOrderStage({}), false);
  assert.equal(isValidOrderStage(""), false);
});

test("isValidOrderStage() returns false for a wrong-case near-miss, proving no case-insensitive matching", () => {
  assert.equal(isValidOrderStage("None"), false);
});

// --- canTransitionOrderStage() - full matrix, derived dynamically ---

test("canTransitionOrderStage() matches index(to) - index(from) in {0, 1} for every pair in the 5x5 matrix", () => {
  for (const { fromStage, toStage } of ALL_PAIRS) {
    const delta = ORDER_STAGES.indexOf(toStage) - ORDER_STAGES.indexOf(fromStage);
    const expected = delta === 0 || delta === 1;
    assert.equal(canTransitionOrderStage(fromStage, toStage), expected, `${fromStage} -> ${toStage}`);
  }
});

test("the generated matrix produces exactly 9 legal pairs and 16 illegal pairs", () => {
  assert.equal(LEGAL_PAIRS.length, 9);
  assert.equal(ILLEGAL_PAIRS.length, 16);
});

test("canTransitionOrderStage() throws when fromStage is not a valid stage", () => {
  assert.throws(() => canTransitionOrderStage("shipped", "none"), /not a valid order stage/);
  assert.throws(() => canTransitionOrderStage(undefined, "none"), /not a valid order stage/);
  assert.throws(() => canTransitionOrderStage(null, "none"), /not a valid order stage/);
  assert.throws(() => canTransitionOrderStage(42, "none"), /not a valid order stage/);
});

test("canTransitionOrderStage() throws when toStage is not a valid stage", () => {
  assert.throws(() => canTransitionOrderStage("none", "shipped"), /not a valid order stage/);
  assert.throws(() => canTransitionOrderStage("none", undefined), /not a valid order stage/);
  assert.throws(() => canTransitionOrderStage("none", null), /not a valid order stage/);
  assert.throws(() => canTransitionOrderStage("none", 42), /not a valid order stage/);
});

test("canTransitionOrderStage() never throws for well-formed valid/valid combinations", () => {
  assert.doesNotThrow(() => canTransitionOrderStage("none", "none"));
  assert.doesNotThrow(() => canTransitionOrderStage("created", "created"));
});

// --- transitionOrderStage() ---

test("transitionOrderStage() returns toStage exactly for every legal pair", () => {
  for (const { fromStage, toStage } of LEGAL_PAIRS) {
    assert.equal(transitionOrderStage(fromStage, toStage), toStage);
  }
});

test("transitionOrderStage() throws the illegal-transition message for every illegal pair", () => {
  for (const { fromStage, toStage } of ILLEGAL_PAIRS) {
    assert.throws(
      () => transitionOrderStage(fromStage, toStage),
      new RegExp(`cannot move from '${fromStage}' to '${toStage}'`)
    );
  }
});

test("transitionOrderStage() throws the contract-violation message (not the illegal-transition message) for malformed input", () => {
  assert.throws(() => transitionOrderStage("shipped", "none"), /not a valid order stage/);
  assert.throws(() => transitionOrderStage("none", "shipped"), /not a valid order stage/);
  assert.throws(() => transitionOrderStage(undefined, "none"), /not a valid order stage/);
});

test("transitionOrderStage()'s return value is the literal toStage string passed in", () => {
  const toStage = "collecting_info";
  assert.equal(transitionOrderStage("none", toStage), toStage);
});

// --- Structural check: no forbidden imports in this file ---

test("orderEngine.js imports nothing from store.js, sheetsClient.js, router/, orchestration/, or reply/", () => {
  const filePath = fileURLToPath(new URL("./orderEngine.js", import.meta.url));
  const source = readFileSync(filePath, "utf8");
  // Scoped to actual import statements (`from "..."`), not the whole file
  // body - orderEngine.js's Task 0 header comments legitimately discuss
  // store.js/sheetsClient.js by name (to document why it doesn't reuse
  // them), and a bare substring scan over raw prose would false-positive
  // on that documentation.
  assert.ok(!/from\s+["'][^"']*store\.js["']/.test(source), "must not import store.js");
  assert.ok(!/from\s+["'][^"']*sheetsClient\.js["']/.test(source), "must not import sheetsClient.js");
  assert.ok(!/from\s+["'][^"']*\/(router|orchestration|reply)\//.test(source), "must not import from router/, orchestration/, or reply/");
});

// =====================================================================
// Grounded Confirmation (Sprint 3 Task 2) - confirmGroundedOrder()
// =====================================================================
//
// Test fixtures below mock getValuesFn at the raw-Sheets-response level
// (header row + data rows), the same level Task 0's freshReadRows() tests
// use, so these tests exercise the real freshReadRows()/pick()/normalize()
// composition rather than a stand-in. getFreshDeliveryQuote is mocked
// directly, since it represents the injected Delivery Engine boundary this
// function never implements.

const DEFAULT_PRODUCTS_SHEET = [
  ["Product", "Color", "Size", "Price", "Stock"],
  ["Fella", "Noir", "38", "3200", "5"],
];

function baseOrderState(overrides = {}) {
  return {
    stage: "awaiting_confirmation",
    validatedProductId: "Fella",
    validatedVariant: { color: "Noir", size: "38" },
    productPrice: 3200,
    wilaya: "Alger",
    commune: "Bab El Oued",
    deliveryType: "home",
    deliveryPrice: 400,
    lastConfirmedPriceShownAt: null,
    ...overrides,
  };
}

function baseDeps(overrides = {}) {
  return {
    getValuesFn: async () => DEFAULT_PRODUCTS_SHEET,
    getFreshDeliveryQuote: async () => ({ price: 400, matched: true }),
    ...overrides,
  };
}

function countingGetValuesFn(rows = DEFAULT_PRODUCTS_SHEET) {
  const fn = async () => rows;
  fn.calls = 0;
  const wrapped = async (...args) => {
    wrapped.calls++;
    return fn(...args);
  };
  wrapped.calls = 0;
  return wrapped;
}

function countingGetFreshDeliveryQuote(result = { price: 400, matched: true }) {
  const wrapped = async () => result;
  wrapped.calls = 0;
  const counted = async (...args) => {
    counted.calls++;
    return wrapped(...args);
  };
  counted.calls = 0;
  return counted;
}

// Scoped to invalid-orderState-field tests only: deps passed in must always
// be a fully valid deps object (e.g. baseDeps()), since this helper only
// swaps in counting mocks for the two dependency functions - it does not
// (and cannot correctly) exercise invalid deps/getValuesFn/getFreshDeliveryQuote
// themselves, because the spread-then-override below would silently replace
// any invalid value with a valid counting mock before the precondition check
// runs. Dependency-validity tests are written directly, without this helper.
async function assertNeitherDependencyCalled(orderState, deps, errorClass) {
  const getValuesFn = countingGetValuesFn();
  const getFreshDeliveryQuote = countingGetFreshDeliveryQuote();
  await assert.rejects(
    () => confirmGroundedOrder(orderState, { ...deps, getValuesFn, getFreshDeliveryQuote }),
    errorClass
  );
  assert.equal(getValuesFn.calls, 0, "getValuesFn must not be called on a precondition failure");
  assert.equal(getFreshDeliveryQuote.calls, 0, "getFreshDeliveryQuote must not be called on a precondition failure");
}

// --- Structural preconditions (throws before either Fresh Read starts) ---

test("confirmGroundedOrder() throws TypeError if orderState is null or not an object, and calls neither dependency", async () => {
  await assertNeitherDependencyCalled(null, baseDeps(), TypeError);
  await assertNeitherDependencyCalled("not an object", baseDeps(), TypeError);
});

test("confirmGroundedOrder() throws RangeError if stage is not a recognized order stage", async () => {
  await assertNeitherDependencyCalled(baseOrderState({ stage: "shipped" }), baseDeps(), RangeError);
});

test("confirmGroundedOrder() throws RangeError if stage is valid but not 'awaiting_confirmation'", async () => {
  await assertNeitherDependencyCalled(baseOrderState({ stage: "confirmed" }), baseDeps(), RangeError);
  await assertNeitherDependencyCalled(baseOrderState({ stage: "none" }), baseDeps(), RangeError);
});

test("confirmGroundedOrder() throws TypeError if validatedProductId is missing or the wrong type", async () => {
  await assertNeitherDependencyCalled(baseOrderState({ validatedProductId: 123 }), baseDeps(), TypeError);
  await assertNeitherDependencyCalled(baseOrderState({ validatedProductId: undefined }), baseDeps(), TypeError);
});

test("confirmGroundedOrder() throws RangeError if validatedProductId is empty or whitespace-only", async () => {
  await assertNeitherDependencyCalled(baseOrderState({ validatedProductId: "" }), baseDeps(), RangeError);
  await assertNeitherDependencyCalled(baseOrderState({ validatedProductId: "   " }), baseDeps(), RangeError);
});

test("confirmGroundedOrder() throws TypeError if validatedVariant is missing or not an object", async () => {
  await assertNeitherDependencyCalled(baseOrderState({ validatedVariant: null }), baseDeps(), TypeError);
  await assertNeitherDependencyCalled(baseOrderState({ validatedVariant: "Noir/38" }), baseDeps(), TypeError);
});

test("confirmGroundedOrder() throws for validatedVariant.color: wrong type -> TypeError, empty/whitespace -> RangeError", async () => {
  await assertNeitherDependencyCalled(
    baseOrderState({ validatedVariant: { color: 1, size: "38" } }),
    baseDeps(),
    TypeError
  );
  await assertNeitherDependencyCalled(
    baseOrderState({ validatedVariant: { color: "", size: "38" } }),
    baseDeps(),
    RangeError
  );
  await assertNeitherDependencyCalled(
    baseOrderState({ validatedVariant: { color: "   ", size: "38" } }),
    baseDeps(),
    RangeError
  );
});

test("confirmGroundedOrder() throws for validatedVariant.size: wrong type -> TypeError, empty/whitespace -> RangeError", async () => {
  await assertNeitherDependencyCalled(
    baseOrderState({ validatedVariant: { color: "Noir", size: 38 } }),
    baseDeps(),
    TypeError
  );
  await assertNeitherDependencyCalled(
    baseOrderState({ validatedVariant: { color: "Noir", size: "" } }),
    baseDeps(),
    RangeError
  );
  await assertNeitherDependencyCalled(
    baseOrderState({ validatedVariant: { color: "Noir", size: "   " } }),
    baseDeps(),
    RangeError
  );
});

test("confirmGroundedOrder() throws for wilaya: wrong type -> TypeError, empty/whitespace -> RangeError", async () => {
  await assertNeitherDependencyCalled(baseOrderState({ wilaya: 16 }), baseDeps(), TypeError);
  await assertNeitherDependencyCalled(baseOrderState({ wilaya: "" }), baseDeps(), RangeError);
  await assertNeitherDependencyCalled(baseOrderState({ wilaya: "   " }), baseDeps(), RangeError);
});

test("confirmGroundedOrder() throws for commune: wrong type -> TypeError, empty/whitespace -> RangeError", async () => {
  await assertNeitherDependencyCalled(baseOrderState({ commune: 16 }), baseDeps(), TypeError);
  await assertNeitherDependencyCalled(baseOrderState({ commune: "" }), baseDeps(), RangeError);
  await assertNeitherDependencyCalled(baseOrderState({ commune: "   " }), baseDeps(), RangeError);
});

test("confirmGroundedOrder() throws for deliveryType: wrong type -> TypeError, invalid value -> RangeError", async () => {
  await assertNeitherDependencyCalled(baseOrderState({ deliveryType: 1 }), baseDeps(), TypeError);
  await assertNeitherDependencyCalled(baseOrderState({ deliveryType: "express" }), baseDeps(), RangeError);
});

test("confirmGroundedOrder() throws TypeError if deps is omitted entirely", async () => {
  await assert.rejects(() => confirmGroundedOrder(baseOrderState()), TypeError);
});

test("confirmGroundedOrder() throws TypeError if deps is null", async () => {
  await assert.rejects(() => confirmGroundedOrder(baseOrderState(), null), TypeError);
});

test("confirmGroundedOrder() throws TypeError if deps is not an object", async () => {
  await assert.rejects(() => confirmGroundedOrder(baseOrderState(), "not an object"), TypeError);
});

test("confirmGroundedOrder() throws TypeError if deps.getValuesFn is not a function, and never calls getFreshDeliveryQuote", async () => {
  const getFreshDeliveryQuote = countingGetFreshDeliveryQuote();
  await assert.rejects(
    () => confirmGroundedOrder(baseOrderState(), { getValuesFn: "nope", getFreshDeliveryQuote }),
    TypeError
  );
  assert.equal(getFreshDeliveryQuote.calls, 0, "getFreshDeliveryQuote must not be called when getValuesFn is invalid");
});

test("confirmGroundedOrder() throws TypeError if deps.getFreshDeliveryQuote is not a function, and never calls getValuesFn", async () => {
  const getValuesFn = countingGetValuesFn();
  await assert.rejects(
    () => confirmGroundedOrder(baseOrderState(), { getValuesFn, getFreshDeliveryQuote: "nope" }),
    TypeError
  );
  assert.equal(getValuesFn.calls, 0, "getValuesFn must not be called when getFreshDeliveryQuote is invalid");
});

test("confirmGroundedOrder() invokes both getValuesFn and getFreshDeliveryQuote exactly once on a structurally valid call", async () => {
  const getValuesFn = countingGetValuesFn();
  const getFreshDeliveryQuote = countingGetFreshDeliveryQuote();
  await confirmGroundedOrder(baseOrderState(), { getValuesFn, getFreshDeliveryQuote });
  assert.equal(getValuesFn.calls, 1);
  assert.equal(getFreshDeliveryQuote.calls, 1);
});

// --- Canonical matching ---

test("confirmGroundedOrder() proceeds past matching on exact product+color+size equality", async () => {
  const result = await confirmGroundedOrder(baseOrderState(), baseDeps());
  assert.equal(result.status, "confirmed");
});

test("confirmGroundedOrder() never fuzzy-matches a merely similar product name", async () => {
  const result = await confirmGroundedOrder(
    baseOrderState({ validatedProductId: "Fella" }),
    baseDeps({
      getValuesFn: async () => [
        ["Product", "Color", "Size", "Price", "Stock"],
        ["Fellah", "Noir", "38", "3200", "5"],
      ],
    })
  );
  assert.equal(result.status, "variant_unavailable");
});

// --- Dot-only defect containment ---

test("confirmGroundedOrder() never parses '1.200' as 1.2 - rejects it as grounding_failure", async () => {
  const result = await confirmGroundedOrder(
    baseOrderState(),
    baseDeps({
      getValuesFn: async () => [
        ["Product", "Color", "Size", "Price", "Stock"],
        ["Fella", "Noir", "38", "1.200", "5"],
      ],
    })
  );
  assert.deepEqual(result, { status: "grounding_failure", patch: {}, reason: "product_price" });
});

test("confirmGroundedOrder() accepts '12.50' as a valid dot-decimal price", async () => {
  const result = await confirmGroundedOrder(
    baseOrderState({ productPrice: 12.5 }),
    baseDeps({
      getValuesFn: async () => [
        ["Product", "Color", "Size", "Price", "Stock"],
        ["Fella", "Noir", "38", "12.50", "5"],
      ],
    })
  );
  assert.equal(result.status, "confirmed");
  assert.equal(result.freshValues.price, 12.5);
});

test("confirmGroundedOrder() accepts '1200,50' as a valid comma-decimal price", async () => {
  const result = await confirmGroundedOrder(
    baseOrderState({ productPrice: 1200.5 }),
    baseDeps({
      getValuesFn: async () => [
        ["Product", "Color", "Size", "Price", "Stock"],
        ["Fella", "Noir", "38", "1200,50", "5"],
      ],
    })
  );
  assert.equal(result.status, "confirmed");
  assert.equal(result.freshValues.price, 1200.5);
});

test("confirmGroundedOrder() accepts '1,200' as a valid comma-thousands price", async () => {
  const result = await confirmGroundedOrder(
    baseOrderState({ productPrice: 1200 }),
    baseDeps({
      getValuesFn: async () => [
        ["Product", "Color", "Size", "Price", "Stock"],
        ["Fella", "Noir", "38", "1,200", "5"],
      ],
    })
  );
  assert.equal(result.status, "confirmed");
  assert.equal(result.freshValues.price, 1200);
});

// --- Other malformed/ambiguous separator formats ---

const MALFORMED_PRICE_CELLS = ["1..2", "1,,2", "1,2,3", "1.200,50", "1.2000", "1,2000", "abc1xyz", "-500"];

for (const cell of MALFORMED_PRICE_CELLS) {
  test(`confirmGroundedOrder() rejects malformed price cell '${cell}' as grounding_failure/product_price`, async () => {
    const result = await confirmGroundedOrder(
      baseOrderState(),
      baseDeps({
        getValuesFn: async () => [
          ["Product", "Color", "Size", "Price", "Stock"],
          ["Fella", "Noir", "38", cell, "5"],
        ],
      })
    );
    assert.deepEqual(result, { status: "grounding_failure", patch: {}, reason: "product_price" });
  });
}

test("confirmGroundedOrder() rejects an empty/missing product price as grounding_failure/product_price", async () => {
  const result = await confirmGroundedOrder(
    baseOrderState(),
    baseDeps({
      getValuesFn: async () => [
        ["Product", "Color", "Size", "Price", "Stock"],
        ["Fella", "Noir", "38", "", "5"],
      ],
    })
  );
  assert.deepEqual(result, { status: "grounding_failure", patch: {}, reason: "product_price" });
});

test("confirmGroundedOrder() rejects an empty/missing stock as grounding_failure/product_stock", async () => {
  const result = await confirmGroundedOrder(
    baseOrderState(),
    baseDeps({
      getValuesFn: async () => [
        ["Product", "Color", "Size", "Price", "Stock"],
        ["Fella", "Noir", "38", "3200", ""],
      ],
    })
  );
  assert.deepEqual(result, { status: "grounding_failure", patch: {}, reason: "product_stock" });
});

test("confirmGroundedOrder() rejects clearly non-numeric stock as grounding_failure/product_stock", async () => {
  const result = await confirmGroundedOrder(
    baseOrderState(),
    baseDeps({
      getValuesFn: async () => [
        ["Product", "Color", "Size", "Price", "Stock"],
        ["Fella", "Noir", "38", "3200", "abc"],
      ],
    })
  );
  assert.deepEqual(result, { status: "grounding_failure", patch: {}, reason: "product_stock" });
});

test("confirmGroundedOrder() rejects a stock cell containing a separator, e.g. '1,200'", async () => {
  const result = await confirmGroundedOrder(
    baseOrderState(),
    baseDeps({
      getValuesFn: async () => [
        ["Product", "Color", "Size", "Price", "Stock"],
        ["Fella", "Noir", "38", "3200", "1,200"],
      ],
    })
  );
  assert.deepEqual(result, { status: "grounding_failure", patch: {}, reason: "product_stock" });
});

// --- Other invalid values ---

test("confirmGroundedOrder() rejects negative stock as grounding_failure/product_stock", async () => {
  const result = await confirmGroundedOrder(
    baseOrderState(),
    baseDeps({
      getValuesFn: async () => [
        ["Product", "Color", "Size", "Price", "Stock"],
        ["Fella", "Noir", "38", "3200", "-1"],
      ],
    })
  );
  assert.deepEqual(result, { status: "grounding_failure", patch: {}, reason: "product_stock" });
});

test("confirmGroundedOrder() rejects fractional stock as grounding_failure/product_stock", async () => {
  const result = await confirmGroundedOrder(
    baseOrderState(),
    baseDeps({
      getValuesFn: async () => [
        ["Product", "Color", "Size", "Price", "Stock"],
        ["Fella", "Noir", "38", "3200", "2.5"],
      ],
    })
  );
  assert.deepEqual(result, { status: "grounding_failure", patch: {}, reason: "product_stock" });
});

test("confirmGroundedOrder() rejects a negative delivery price as grounding_failure/delivery", async () => {
  const result = await confirmGroundedOrder(
    baseOrderState(),
    baseDeps({ getFreshDeliveryQuote: async () => ({ price: -100, matched: true }) })
  );
  assert.deepEqual(result, { status: "grounding_failure", patch: {}, reason: "delivery" });
});

test("confirmGroundedOrder() rejects a valid product row when the delivery quote is unmatched, as grounding_failure/delivery", async () => {
  const result = await confirmGroundedOrder(
    baseOrderState(),
    baseDeps({ getFreshDeliveryQuote: async () => ({ price: null, matched: false }) })
  );
  assert.deepEqual(result, { status: "grounding_failure", patch: {}, reason: "delivery" });
});

for (const badPrice of [null, undefined, "400", NaN]) {
  test(`confirmGroundedOrder() rejects a matched delivery quote with price=${String(badPrice)} as grounding_failure/delivery`, async () => {
    const result = await confirmGroundedOrder(
      baseOrderState(),
      baseDeps({ getFreshDeliveryQuote: async () => ({ price: badPrice, matched: true }) })
    );
    assert.deepEqual(result, { status: "grounding_failure", patch: {}, reason: "delivery" });
  });
}

test("confirmGroundedOrder() rejects an invalid stored productPrice as grounding_failure/stored_price", async () => {
  const result = await confirmGroundedOrder(baseOrderState({ productPrice: NaN }), baseDeps());
  assert.deepEqual(result, { status: "grounding_failure", patch: {}, reason: "stored_price" });

  const result2 = await confirmGroundedOrder(baseOrderState({ productPrice: -1 }), baseDeps());
  assert.deepEqual(result2, { status: "grounding_failure", patch: {}, reason: "stored_price" });
});

test("confirmGroundedOrder() rejects an invalid stored deliveryPrice as grounding_failure/stored_delivery_price", async () => {
  const result = await confirmGroundedOrder(baseOrderState({ deliveryPrice: NaN }), baseDeps());
  assert.deepEqual(result, { status: "grounding_failure", patch: {}, reason: "stored_delivery_price" });

  const result2 = await confirmGroundedOrder(baseOrderState({ deliveryPrice: -1 }), baseDeps());
  assert.deepEqual(result2, { status: "grounding_failure", patch: {}, reason: "stored_delivery_price" });
});

// --- Stock-zero distinctness ---

test("confirmGroundedOrder() returns out_of_stock for a valid numeric stock of 0, distinct from invalid-stock cases", async () => {
  const result = await confirmGroundedOrder(
    baseOrderState(),
    baseDeps({
      getValuesFn: async () => [
        ["Product", "Color", "Size", "Price", "Stock"],
        ["Fella", "Noir", "38", "3200", "0"],
      ],
    })
  );
  assert.deepEqual(result, { status: "out_of_stock", patch: {} });
});

// --- Resolved-dependency shape validation ---

test("confirmGroundedOrder() rejects a deliveryQuote resolving to null as grounding_failure/delivery_read_shape", async () => {
  const result = await confirmGroundedOrder(baseOrderState(), baseDeps({ getFreshDeliveryQuote: async () => null }));
  assert.deepEqual(result, { status: "grounding_failure", patch: {}, reason: "delivery_read_shape" });
});

test("confirmGroundedOrder() rejects a deliveryQuote resolving to an array as grounding_failure/delivery_read_shape", async () => {
  const result = await confirmGroundedOrder(baseOrderState(), baseDeps({ getFreshDeliveryQuote: async () => [400, true] }));
  assert.deepEqual(result, { status: "grounding_failure", patch: {}, reason: "delivery_read_shape" });
});

test("confirmGroundedOrder() rejects a deliveryQuote missing 'matched' entirely as grounding_failure/delivery_read_shape", async () => {
  const result = await confirmGroundedOrder(baseOrderState(), baseDeps({ getFreshDeliveryQuote: async () => ({ price: 400 }) }));
  assert.deepEqual(result, { status: "grounding_failure", patch: {}, reason: "delivery_read_shape" });
});

test("confirmGroundedOrder() rejects a deliveryQuote with a non-boolean 'matched' as grounding_failure/delivery_read_shape", async () => {
  const result = await confirmGroundedOrder(
    baseOrderState(),
    baseDeps({ getFreshDeliveryQuote: async () => ({ price: 400, matched: "true" }) })
  );
  assert.deepEqual(result, { status: "grounding_failure", patch: {}, reason: "delivery_read_shape" });
});

test("confirmGroundedOrder() returns grounding_failure/delivery_read_shape when the delivery quote resolves to undefined", async () => {
  const result = await confirmGroundedOrder(baseOrderState(), baseDeps({ getFreshDeliveryQuote: async () => undefined }));
  assert.deepEqual(result, { status: "grounding_failure", patch: {}, reason: "delivery_read_shape" });
});

// --- Fresh Read behavior ---

test("confirmGroundedOrder() always calls getValuesFn with { ttlMs: 0 }", async () => {
  let capturedOptions;
  const getValuesFn = async (range, options) => {
    capturedOptions = options;
    return DEFAULT_PRODUCTS_SHEET;
  };
  await confirmGroundedOrder(baseOrderState(), baseDeps({ getValuesFn }));
  assert.deepEqual(capturedOptions, { ttlMs: 0 });
});

// --- Facts-changed aggregation ---

test("confirmGroundedOrder() aggregates both changed price and changed delivery price into a single facts_changed result", async () => {
  const result = await confirmGroundedOrder(
    baseOrderState({ productPrice: 3000, deliveryPrice: 350 }),
    baseDeps({
      getValuesFn: async () => [
        ["Product", "Color", "Size", "Price", "Stock"],
        ["Fella", "Noir", "38", "3200", "5"],
      ],
      getFreshDeliveryQuote: async () => ({ price: 400, matched: true }),
    })
  );
  assert.deepEqual(result, {
    status: "facts_changed",
    patch: {},
    changedFields: ["price", "deliveryPrice"],
    freshValues: { price: 3200, deliveryPrice: 400 },
    previousValues: { price: 3000, deliveryPrice: 350 },
  });
});

test("confirmGroundedOrder() returns facts_changed with changedFields ['price'] only when just the product price changed", async () => {
  const result = await confirmGroundedOrder(
    baseOrderState({ productPrice: 3000, deliveryPrice: 400 }),
    baseDeps({
      getValuesFn: async () => [
        ["Product", "Color", "Size", "Price", "Stock"],
        ["Fella", "Noir", "38", "3200", "5"],
      ],
      getFreshDeliveryQuote: async () => ({ price: 400, matched: true }),
    })
  );
  assert.deepEqual(result, {
    status: "facts_changed",
    patch: {},
    changedFields: ["price"],
    freshValues: { price: 3200, deliveryPrice: 400 },
    previousValues: { price: 3000, deliveryPrice: 400 },
  });
});

test("confirmGroundedOrder() returns facts_changed with changedFields ['deliveryPrice'] only when just the delivery price changed", async () => {
  const result = await confirmGroundedOrder(
    baseOrderState({ productPrice: 3200, deliveryPrice: 350 }),
    baseDeps({
      getValuesFn: async () => [
        ["Product", "Color", "Size", "Price", "Stock"],
        ["Fella", "Noir", "38", "3200", "5"],
      ],
      getFreshDeliveryQuote: async () => ({ price: 400, matched: true }),
    })
  );
  assert.deepEqual(result, {
    status: "facts_changed",
    patch: {},
    changedFields: ["deliveryPrice"],
    freshValues: { price: 3200, deliveryPrice: 400 },
    previousValues: { price: 3200, deliveryPrice: 350 },
  });
});

// --- Simultaneous product-side + delivery-side failures ---

test("confirmGroundedOrder() returns variant_unavailable, not grounding_failure, when the row is missing and delivery is also unmatched", async () => {
  const result = await confirmGroundedOrder(
    baseOrderState(),
    baseDeps({
      getValuesFn: async () => [
        ["Product", "Color", "Size", "Price", "Stock"],
        ["Fellah", "Noir", "38", "3200", "5"],
      ],
      getFreshDeliveryQuote: async () => ({ price: null, matched: false }),
    })
  );
  assert.deepEqual(result, { status: "variant_unavailable", patch: {} });
});

test("confirmGroundedOrder() returns out_of_stock, not grounding_failure, when stock is validly 0 and delivery is also unmatched", async () => {
  const result = await confirmGroundedOrder(
    baseOrderState(),
    baseDeps({
      getValuesFn: async () => [
        ["Product", "Color", "Size", "Price", "Stock"],
        ["Fella", "Noir", "38", "3200", "0"],
      ],
      getFreshDeliveryQuote: async () => ({ price: null, matched: false }),
    })
  );
  assert.deepEqual(result, { status: "out_of_stock", patch: {} });
});

test("confirmGroundedOrder() returns out_of_stock even when the same row's price is also malformed", async () => {
  const result = await confirmGroundedOrder(
    baseOrderState(),
    baseDeps({
      getValuesFn: async () => [
        ["Product", "Color", "Size", "Price", "Stock"],
        ["Fella", "Noir", "38", "abc", "0"],
      ],
    })
  );
  assert.deepEqual(result, { status: "out_of_stock", patch: {} });
});

test("confirmGroundedOrder() returns variant_unavailable when the row is missing even if the delivery quote shape is malformed", async () => {
  const result = await confirmGroundedOrder(
    baseOrderState(),
    baseDeps({
      getValuesFn: async () => [
        ["Product", "Color", "Size", "Price", "Stock"],
        ["Fellah", "Noir", "38", "3200", "5"],
      ],
      getFreshDeliveryQuote: async () => null,
    })
  );
  assert.deepEqual(result, { status: "variant_unavailable", patch: {} });
});

// --- Technical failure precedence ---

test("confirmGroundedOrder() rejects if getValuesFn rejects, even if getFreshDeliveryQuote would resolve to a business failure", async () => {
  await assert.rejects(() =>
    confirmGroundedOrder(
      baseOrderState(),
      baseDeps({
        getValuesFn: async () => {
          throw new Error("Sheets API timeout");
        },
        getFreshDeliveryQuote: async () => ({ price: null, matched: false }),
      })
    )
  );
});

test("confirmGroundedOrder() rejects if getFreshDeliveryQuote rejects, even if getValuesFn would resolve to a business failure", async () => {
  await assert.rejects(() =>
    confirmGroundedOrder(
      baseOrderState(),
      baseDeps({
        getValuesFn: async () => [
          ["Product", "Color", "Size", "Price", "Stock"],
          ["Fellah", "Noir", "38", "3200", "5"],
        ],
        getFreshDeliveryQuote: async () => {
          throw new Error("Delivery boundary timeout");
        },
      })
    )
  );
});

// --- Confirmed path: stage patch reuses Task 1's transitionOrderStage() ---

test("confirmGroundedOrder() proposes patch.stage 'confirmed' via the existing Task 1 transition, and never persists it itself", async () => {
  const result = await confirmGroundedOrder(baseOrderState(), baseDeps());
  assert.deepEqual(result, {
    status: "confirmed",
    patch: { stage: "confirmed" },
    freshValues: { price: 3200, deliveryPrice: 400 },
  });
});

// =====================================================================
// Idempotent Order Creation (Sprint 3 Task 3) - createIdempotentOrder()
// =====================================================================
//
// createOrderRecord is the injected atomic idempotency boundary. These
// tests prove Order Engine's own contract behavior (always calls it, on
// every structurally valid attempt, never bypasses it, never retries
// internally, correctly maps its resolved response) against fakes that
// simulate an atomic persistence layer. They do not, and cannot, prove
// production/durable idempotency - that depends entirely on whatever real
// implementation eventually satisfies this contract, which does not yet
// exist (store.js's createOrder() and the real ORDERS schema have no
// message-ID column and no check-before-write, per Task 3's plan).

function baseCreationOrderState(overrides = {}) {
  return {
    stage: "confirmed",
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

function countingCreateOrderRecord(result) {
  const fn = async () => result;
  const wrapped = async (...args) => {
    wrapped.calls++;
    return fn(...args);
  };
  wrapped.calls = 0;
  return wrapped;
}

// Simulates an atomic persistence layer: a Map keyed by idempotencyKey
// decides created/already_created for itself - createIdempotentOrder never
// makes this decision on its own.
function makeAtomicCreateOrderRecord() {
  const store = new Map();
  const fn = async (idempotencyKey, payload) => {
    if (store.has(idempotencyKey)) {
      return { outcome: "already_created", order: store.get(idempotencyKey) };
    }
    const order = { orderId: `DL-${store.size + 1}`, total: payload.totalPrice };
    store.set(idempotencyKey, order);
    return { outcome: "created", order };
  };
  fn.store = store;
  return fn;
}

// Simulates an ambiguous commit: the first call atomically stores the
// order, then the response is lost (rejects) before the caller ever learns
// it succeeded. A retry with the same key must find the already-stored
// record and return already_created, never a second created.
function makeAmbiguousCommitThenRetryFake() {
  const store = new Map();
  let callCount = 0;
  const fn = async (idempotencyKey, payload) => {
    callCount++;
    if (callCount === 1) {
      store.set(idempotencyKey, { orderId: "DL-1", total: payload.totalPrice });
      throw new Error("response lost after write succeeded");
    }
    if (store.has(idempotencyKey)) {
      return { outcome: "already_created", order: store.get(idempotencyKey) };
    }
    const order = { orderId: `DL-${store.size + 1}`, total: payload.totalPrice };
    store.set(idempotencyKey, order);
    return { outcome: "created", order };
  };
  fn.store = store;
  return fn;
}

// Simulates a genuine transient failure before any write occurred - the
// retry is a normal first-time creation, not an idempotent hit.
function makeFailBeforeWriteThenRetryFake() {
  const store = new Map();
  let callCount = 0;
  const fn = async (idempotencyKey, payload) => {
    callCount++;
    if (callCount === 1) {
      throw new Error("transient failure before write");
    }
    if (store.has(idempotencyKey)) {
      return { outcome: "already_created", order: store.get(idempotencyKey) };
    }
    const order = { orderId: `DL-${store.size + 1}`, total: payload.totalPrice };
    store.set(idempotencyKey, order);
    return { outcome: "created", order };
  };
  fn.store = store;
  return fn;
}

// Scoped to invalid-orderState-field and invalid-idempotencyKey tests only:
// deps passed in is always a fully valid { createOrderRecord } object, so
// this only swaps in a counting mock to assert it was never called. Deps-
// validity tests (deps null/not-object/createOrderRecord-not-a-function)
// are written directly, without this helper, for the same reason Task 2's
// equivalent helper is scoped this way - overriding an invalid deps value
// with a valid mock would silently defeat the precondition being tested.
async function assertCreateOrderRecordNotCalled(orderState, idempotencyKey, errorClass) {
  const createOrderRecord = countingCreateOrderRecord({ outcome: "created", order: {} });
  await assert.rejects(
    () => createIdempotentOrder(orderState, idempotencyKey, { createOrderRecord }),
    errorClass
  );
  assert.equal(createOrderRecord.calls, 0, "createOrderRecord must not be called on a precondition failure");
}

// --- Structural preconditions (throws before createOrderRecord is ever called) ---

test("createIdempotentOrder() throws TypeError if orderState is null or not an object", async () => {
  await assertCreateOrderRecordNotCalled(null, "wamid.1", TypeError);
  await assertCreateOrderRecordNotCalled("not an object", "wamid.1", TypeError);
});

test("createIdempotentOrder() throws RangeError if stage is not a recognized order stage", async () => {
  await assertCreateOrderRecordNotCalled(baseCreationOrderState({ stage: "shipped" }), "wamid.1", RangeError);
});

test("createIdempotentOrder() throws RangeError if stage is a valid stage but not 'confirmed' or 'created'", async () => {
  await assertCreateOrderRecordNotCalled(baseCreationOrderState({ stage: "none" }), "wamid.1", RangeError);
  await assertCreateOrderRecordNotCalled(baseCreationOrderState({ stage: "collecting_info" }), "wamid.1", RangeError);
  await assertCreateOrderRecordNotCalled(baseCreationOrderState({ stage: "awaiting_confirmation" }), "wamid.1", RangeError);
});

test("createIdempotentOrder() throws TypeError if idempotencyKey is not a string", async () => {
  await assertCreateOrderRecordNotCalled(baseCreationOrderState(), 12345, TypeError);
});

test("createIdempotentOrder() throws RangeError if idempotencyKey is empty or whitespace-only", async () => {
  await assertCreateOrderRecordNotCalled(baseCreationOrderState(), "", RangeError);
  await assertCreateOrderRecordNotCalled(baseCreationOrderState(), "   ", RangeError);
});

test("createIdempotentOrder() throws RangeError if productPrice, deliveryPrice, or totalPrice is invalid", async () => {
  await assertCreateOrderRecordNotCalled(baseCreationOrderState({ productPrice: NaN }), "wamid.1", RangeError);
  await assertCreateOrderRecordNotCalled(baseCreationOrderState({ deliveryPrice: -1 }), "wamid.1", RangeError);
  await assertCreateOrderRecordNotCalled(baseCreationOrderState({ totalPrice: "3600" }), "wamid.1", RangeError);
});

test("createIdempotentOrder() throws TypeError if deps is omitted entirely", async () => {
  await assert.rejects(() => createIdempotentOrder(baseCreationOrderState(), "wamid.1"), TypeError);
});

test("createIdempotentOrder() throws TypeError if deps is null", async () => {
  await assert.rejects(() => createIdempotentOrder(baseCreationOrderState(), "wamid.1", null), TypeError);
});

test("createIdempotentOrder() throws TypeError if deps is not an object", async () => {
  await assert.rejects(() => createIdempotentOrder(baseCreationOrderState(), "wamid.1", "not an object"), TypeError);
});

test("createIdempotentOrder() throws TypeError if deps.createOrderRecord is not a function", async () => {
  await assert.rejects(
    () => createIdempotentOrder(baseCreationOrderState(), "wamid.1", { createOrderRecord: "nope" }),
    TypeError
  );
});

test("createIdempotentOrder() invokes createOrderRecord exactly once on a structurally valid call", async () => {
  const createOrderRecord = countingCreateOrderRecord({ outcome: "created", order: { orderId: "DL-1", total: 3600 } });
  await createIdempotentOrder(baseCreationOrderState(), "wamid.1", { createOrderRecord });
  assert.equal(createOrderRecord.calls, 1);
});

// --- First creation ---

test("createIdempotentOrder() returns status 'created' with the correct patch and echoed order on first creation", async () => {
  const createOrderRecord = countingCreateOrderRecord({ outcome: "created", order: { orderId: "DL-1", total: 3600 } });
  const result = await createIdempotentOrder(baseCreationOrderState(), "wamid.1", { createOrderRecord });
  assert.deepEqual(result, {
    status: "created",
    patch: { stage: "created", orderCreationStatus: "created" },
    order: { orderId: "DL-1", total: 3600 },
  });
});

// --- T-IDEM-1: contract-level duplicate handling ---

test("T-IDEM-1: a repeated idempotencyKey returns already_created, not a second created, and the fake's record count stays at 1", async () => {
  const createOrderRecord = makeAtomicCreateOrderRecord();
  const first = await createIdempotentOrder(baseCreationOrderState(), "wamid.1", { createOrderRecord });
  const second = await createIdempotentOrder(baseCreationOrderState(), "wamid.1", { createOrderRecord });
  assert.equal(first.status, "created");
  assert.equal(second.status, "already_created");
  assert.equal(createOrderRecord.store.size, 1);
});

// --- Created-stage replay still invoking createOrderRecord ---

test("createIdempotentOrder() still calls createOrderRecord when local stage is already 'created', never shortcuts locally", async () => {
  const createOrderRecord = countingCreateOrderRecord({ outcome: "already_created", order: { orderId: "DL-1", total: 3600 } });
  const result = await createIdempotentOrder(baseCreationOrderState({ stage: "created" }), "wamid.1", { createOrderRecord });
  assert.equal(createOrderRecord.calls, 1);
  assert.deepEqual(result, {
    status: "already_created",
    patch: { stage: "created", orderCreationStatus: "created" },
    order: { orderId: "DL-1", total: 3600 },
  });
});

// --- T-RETRY-3: idempotency check re-verified on every attempt ---

test("T-RETRY-3 ambiguous commit: first call stores then rejects; retry with the same key returns already_created; record count remains 1", async () => {
  const createOrderRecord = makeAmbiguousCommitThenRetryFake();
  await assert.rejects(() => createIdempotentOrder(baseCreationOrderState(), "wamid.1", { createOrderRecord }));
  const retry = await createIdempotentOrder(baseCreationOrderState(), "wamid.1", { createOrderRecord });
  assert.equal(retry.status, "already_created");
  assert.equal(createOrderRecord.store.size, 1);
});

test("T-RETRY-3 failure before write: first call rejects with nothing stored; retry succeeds and record count becomes 1", async () => {
  const createOrderRecord = makeFailBeforeWriteThenRetryFake();
  await assert.rejects(() => createIdempotentOrder(baseCreationOrderState(), "wamid.1", { createOrderRecord }));
  assert.equal(createOrderRecord.store.size, 0);
  const retry = await createIdempotentOrder(baseCreationOrderState(), "wamid.1", { createOrderRecord });
  assert.equal(retry.status, "created");
  assert.equal(createOrderRecord.store.size, 1);
});

// --- Conflict mapping ---

test("createIdempotentOrder() maps a conflict outcome to idempotency_conflict, passing conflictingFields through verbatim", async () => {
  const createOrderRecord = countingCreateOrderRecord({
    outcome: "conflict",
    conflictingFields: ["productPrice", "deliveryPrice"],
    order: { orderId: "DL-1", total: 3000 },
  });
  const result = await createIdempotentOrder(baseCreationOrderState(), "wamid.1", { createOrderRecord });
  assert.deepEqual(result, {
    status: "idempotency_conflict",
    patch: {},
    conflictingFields: ["productPrice", "deliveryPrice"],
  });
});

test("createIdempotentOrder() maps a conflict outcome correctly when order is absent", async () => {
  const createOrderRecord = countingCreateOrderRecord({
    outcome: "conflict",
    conflictingFields: ["totalPrice"],
  });
  const result = await createIdempotentOrder(baseCreationOrderState(), "wamid.1", { createOrderRecord });
  assert.deepEqual(result, {
    status: "idempotency_conflict",
    patch: {},
    conflictingFields: ["totalPrice"],
  });
});

// --- Malformed resolved-response shapes ---

test("createIdempotentOrder() returns persistence_read_shape when the resolved response is not a plain object", async () => {
  for (const bad of [null, undefined, "created", 42, ["created"]]) {
    const createOrderRecord = async () => bad;
    const result = await createIdempotentOrder(baseCreationOrderState(), "wamid.1", { createOrderRecord });
    assert.deepEqual(result, { status: "persistence_read_shape", patch: {} });
  }
});

test("createIdempotentOrder() returns persistence_read_shape when outcome is not one of the three recognized values", async () => {
  const createOrderRecord = async () => ({ outcome: "duplicate", order: {} });
  const result = await createIdempotentOrder(baseCreationOrderState(), "wamid.1", { createOrderRecord });
  assert.deepEqual(result, { status: "persistence_read_shape", patch: {} });
});

test("createIdempotentOrder() returns persistence_read_shape when outcome is created/already_created but order is not a plain object", async () => {
  for (const outcome of ["created", "already_created"]) {
    for (const badOrder of [null, undefined, "DL-1", [1, 2]]) {
      const createOrderRecord = async () => ({ outcome, order: badOrder });
      const result = await createIdempotentOrder(baseCreationOrderState(), "wamid.1", { createOrderRecord });
      assert.deepEqual(result, { status: "persistence_read_shape", patch: {} });
    }
  }
});

test("createIdempotentOrder() returns persistence_read_shape when outcome is conflict but conflictingFields is not an array", async () => {
  const createOrderRecord = async () => ({ outcome: "conflict", conflictingFields: "productPrice" });
  const result = await createIdempotentOrder(baseCreationOrderState(), "wamid.1", { createOrderRecord });
  assert.deepEqual(result, { status: "persistence_read_shape", patch: {} });
});

test("createIdempotentOrder() returns persistence_read_shape when outcome is conflict and a present order is not a plain object", async () => {
  const createOrderRecord = async () => ({ outcome: "conflict", conflictingFields: ["productPrice"], order: "DL-1" });
  const result = await createIdempotentOrder(baseCreationOrderState(), "wamid.1", { createOrderRecord });
  assert.deepEqual(result, { status: "persistence_read_shape", patch: {} });
});

// --- Technical failure propagation ---

test("createIdempotentOrder() propagates a technical rejection from createOrderRecord unchanged, producing no CreationResult", async () => {
  const createOrderRecord = async () => {
    throw new Error("Sheets API timeout");
  };
  await assert.rejects(() => createIdempotentOrder(baseCreationOrderState(), "wamid.1", { createOrderRecord }));
});

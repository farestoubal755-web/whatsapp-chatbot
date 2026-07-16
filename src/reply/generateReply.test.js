// Tests for the Reply-Generation Contract (Sprint 2).
// Run with: node --test src/reply/generateReply.test.js
//
// No live model call anywhere in this file - callModelFn is always a
// fake, injected function, and generateReply() has no default to fall
// back on. These tests prove the envelope validator and the plumbing
// around an injected function; they prove nothing about how a real model
// would actually phrase a reply given real facts.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { generateReply, validateGroundedContext } from "./generateReply.js";

const validContext = {
  systemDecision: "LOOKUP_PRODUCT_AND_RESPOND",
  facts: { productName: "Fella", color: "Noir", size: "38", price: 3200, currency: "DA" },
  language: "darija",
  storeName: "DAR LAFFAIRE",
};

test("generateReply() throws immediately if callModelFn is missing", async () => {
  await assert.rejects(() => generateReply(validContext, {}), /requires an injected callModelFn/);
});

test("generateReply() throws immediately if callModelFn is not a function", async () => {
  await assert.rejects(() => generateReply(validContext, { callModelFn: "nope" }), /requires an injected callModelFn/);
});

test("generateReply() returns the injected callModelFn's result for a valid envelope", async () => {
  const fakeCallModelFn = async () => "تم توصلنا برسالتك";
  const result = await generateReply(validContext, { callModelFn: fakeCallModelFn });
  assert.deepEqual(result, { reply: "تم توصلنا برسالتك" });
});

test("generateReply() rejects a callModelFn that returns a non-string/empty result", async () => {
  await assert.rejects(() => generateReply(validContext, { callModelFn: async () => "" }), /non-empty string/);
  await assert.rejects(() => generateReply(validContext, { callModelFn: async () => 42 }), /non-empty string/);
});

// --- Envelope validation: top-level shape ---

test("validateGroundedContext rejects a non-plain-object envelope", () => {
  assert.throws(() => validateGroundedContext(null), /must be a plain object/);
  assert.throws(() => validateGroundedContext("nope"), /must be a plain object/);
  assert.throws(() => validateGroundedContext([]), /must be a plain object/);
});

test("validateGroundedContext rejects an unexpected top-level key", () => {
  assert.throws(
    () => validateGroundedContext({ ...validContext, orderState: { stage: "none" } }),
    /unexpected top-level key/
  );
});

test("validateGroundedContext requires systemDecision, language, storeName as non-empty strings", () => {
  assert.throws(() => validateGroundedContext({ ...validContext, systemDecision: "" }), /systemDecision/);
  assert.throws(() => validateGroundedContext({ ...validContext, language: 5 }), /language/);
  assert.throws(() => validateGroundedContext({ ...validContext, storeName: null }), /storeName/);
});

test("validateGroundedContext requires facts to be a plain object", () => {
  assert.throws(() => validateGroundedContext({ ...validContext, facts: [] }), /facts must be a plain object/);
  assert.throws(() => validateGroundedContext({ ...validContext, facts: "nope" }), /facts must be a plain object/);
});

// --- Envelope validation: forbidden content inside facts ---

test("rejects a function inside facts", () => {
  assert.throws(
    () => validateGroundedContext({ ...validContext, facts: { helper: () => {} } }),
    /functions are not allowed/
  );
});

test("rejects undefined inside facts", () => {
  assert.throws(
    () => validateGroundedContext({ ...validContext, facts: { price: undefined } }),
    /undefined is not allowed/
  );
});

test("rejects a class instance / non-plain object inside facts (e.g. a Date)", () => {
  assert.throws(
    () => validateGroundedContext({ ...validContext, facts: { fetchedOn: new Date() } }),
    /not a plain, serializable type/
  );
});

test("rejects a Map or Set inside facts", () => {
  assert.throws(() => validateGroundedContext({ ...validContext, facts: { m: new Map() } }), /not a plain, serializable type/);
  assert.throws(() => validateGroundedContext({ ...validContext, facts: { s: new Set() } }), /not a plain, serializable type/);
});

test("rejects credential/token-like key names inside facts", () => {
  assert.throws(() => validateGroundedContext({ ...validContext, facts: { apiKey: "sk-abc" } }), /forbidden key name/);
  assert.throws(() => validateGroundedContext({ ...validContext, facts: { token: "xyz" } }), /forbidden key name/);
  assert.throws(() => validateGroundedContext({ ...validContext, facts: { password: "hunter2" } }), /forbidden key name/);
  assert.throws(() => validateGroundedContext({ ...validContext, facts: { GOOGLE_PRIVATE_KEY: "..." } }), /forbidden key name/);
});

test("rejects internal bookkeeping / session-like key names inside facts", () => {
  assert.throws(() => validateGroundedContext({ ...validContext, facts: { sourceSheet: "PRODUCTS 1" } }), /forbidden key name/);
  assert.throws(() => validateGroundedContext({ ...validContext, facts: { rowNumber: 42 } }), /forbidden key name/);
  assert.throws(() => validateGroundedContext({ ...validContext, facts: { session: {} } }), /forbidden key name/);
});

test("rejects forbidden key names nested deep inside facts", () => {
  assert.throws(
    () => validateGroundedContext({ ...validContext, facts: { candidate: { nested: { apiKey: "sk-abc" } } } }),
    /forbidden key name/
  );
});

test("accepts nested plain objects and arrays of plain facts (e.g. multiple candidates)", () => {
  assert.doesNotThrow(() =>
    validateGroundedContext({
      ...validContext,
      facts: {
        candidates: [
          { productName: "Fella", color: "Noir", size: "38" },
          { productName: "Fella", color: "Noir", size: "39" },
        ],
      },
    })
  );
});

// --- Structural check: no forbidden imports in this file ---

test("generateReply.js imports nothing from sheetsClient.js, store.js, googleapis, or openai", () => {
  const filePath = fileURLToPath(new URL("./generateReply.js", import.meta.url));
  const source = readFileSync(filePath, "utf8");
  assert.ok(!/sheetsClient\.js/.test(source), "must not import sheetsClient.js");
  assert.ok(!/store\.js/.test(source), "must not import store.js");
  assert.ok(!/googleapis/.test(source), "must not import googleapis");
  assert.ok(!/from ["']openai["']/.test(source), "must not import the openai package");
});

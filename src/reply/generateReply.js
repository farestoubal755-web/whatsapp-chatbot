// Reply-Generation Contract (Sprint 2).
//
// generateReply() phrases customer-facing wording from ALREADY-GROUNDED
// facts. It does not decide what to do (that's the Router's job), does
// not read Google Sheets (no import path to reach them anywhere in this
// file), and makes no live model call of its own: callModelFn must be
// injected by the caller. There is no default implementation and no
// OpenAI import anywhere in this file.
//
// This is standalone, unwired code - nothing in server.js calls this.

const ALLOWED_TOP_LEVEL_KEYS = new Set(["systemDecision", "facts", "language", "storeName"]);

// Case-insensitive; matches credential-like fields and known internal
// bookkeeping field names (Cache Entry / session shape, DASP-001 SS2.8)
// that should never appear in a curated facts object. This is a
// best-effort, defense-in-depth check by name - the actual guarantee
// against raw Sheet rows/session objects/clients reaching this file is
// architectural (no import path exists to fetch them in the first place).
const FORBIDDEN_KEY_PATTERN =
  /api[-_]?key|token|secret|password|credential|private[-_]?key|authorization|^auth$|client[-_]?email|service[-_]?account|cookie|session|rownumber|source[-_]?sheet|source[-_]?row|fetchedat|orderstate/i;

function isPlainObject(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function assertSerializable(value, path) {
  if (value === undefined) throw new Error(`${path}: undefined is not allowed`);
  if (typeof value === "function") throw new Error(`${path}: functions are not allowed`);
  if (typeof value === "symbol") throw new Error(`${path}: symbols are not allowed`);
  if (typeof value === "bigint") throw new Error(`${path}: bigint is not allowed`);
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${path}: non-finite numbers are not allowed`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => assertSerializable(item, `${path}[${i}]`));
    return;
  }
  if (isPlainObject(value)) {
    for (const [key, val] of Object.entries(value)) {
      if (FORBIDDEN_KEY_PATTERN.test(key)) {
        throw new Error(`${path}.${key}: forbidden key name (looks like a credential, token, or internal/session field)`);
      }
      assertSerializable(val, `${path}.${key}`);
    }
    return;
  }
  throw new Error(`${path}: value is not a plain, serializable type (class instances, clients, Dates, Maps, etc. are not allowed)`);
}

export function validateGroundedContext(groundedContext) {
  if (!isPlainObject(groundedContext)) {
    throw new Error("groundedContext must be a plain object");
  }
  for (const key of Object.keys(groundedContext)) {
    if (!ALLOWED_TOP_LEVEL_KEYS.has(key)) {
      throw new Error(`groundedContext.${key}: unexpected top-level key - only systemDecision, facts, language, storeName are allowed`);
    }
  }
  if (typeof groundedContext.systemDecision !== "string" || groundedContext.systemDecision.length === 0) {
    throw new Error("groundedContext.systemDecision must be a non-empty string");
  }
  if (typeof groundedContext.language !== "string" || groundedContext.language.length === 0) {
    throw new Error("groundedContext.language must be a non-empty string");
  }
  if (typeof groundedContext.storeName !== "string" || groundedContext.storeName.length === 0) {
    throw new Error("groundedContext.storeName must be a non-empty string");
  }
  if (!isPlainObject(groundedContext.facts)) {
    throw new Error("groundedContext.facts must be a plain object");
  }
  assertSerializable(groundedContext.facts, "facts");
}

function buildInstructions(groundedContext) {
  return `أنت طبقة صياغة الرد فقط لمتجر ${groundedContext.storeName}. مهمتك الوحيدة: صياغة رد بـ${groundedContext.language} باستعمال فقط المعطيات الموجودة في "facts" أدناه. ممنوع اختراع أي معلومة غير موجودة في facts (سعر، مقاس، لون، توفر، أو أي شيء آخر). القرار التجاري (systemDecision) اتخذ مسبقا؛ مهمتك فقط صياغة الكلام، وليس اتخاذ أي قرار.`;
}

export async function generateReply(groundedContext, deps = {}) {
  validateGroundedContext(groundedContext);

  if (typeof deps.callModelFn !== "function") {
    throw new Error("generateReply() requires an injected callModelFn - no default network-calling implementation exists in Sprint 2.");
  }

  const instructions = buildInstructions(groundedContext);
  const input = JSON.stringify({ systemDecision: groundedContext.systemDecision, facts: groundedContext.facts });

  const reply = await deps.callModelFn(instructions, input);
  if (typeof reply !== "string" || reply.length === 0) {
    throw new Error("callModelFn must return a non-empty string");
  }

  return { reply };
}

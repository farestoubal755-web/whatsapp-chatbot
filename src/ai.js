import OpenAI from "openai";
import { cfg } from "./config.js";
import { withRetry } from "./retry.js";

const openai = new OpenAI({ apiKey: cfg.openai.apiKey });

const schema = {
  type: "object",
  additionalProperties: false,
  properties: {
    reply: { type: "string" },
    action: { type: "string", enum: ["reply", "search_products", "confirm_order", "handoff"] },
    search_query: { type: "string" },
    updates: {
      type: "object",
      additionalProperties: false,
      properties: {
        customer_name: { type: "string" },
        wilaya: { type: "string" },
        commune: { type: "string" },
        delivery_type: { type: "string" },
        product: { type: "string" },
        color: { type: "string" },
        size: { type: "string" },
        quantity: { type: "integer" },
        stage: { type: "string" },
      },
      required: ["customer_name", "wilaya", "commune", "delivery_type", "product", "color", "size", "quantity", "stage"],
    },
  },
  required: ["reply", "action", "search_query", "updates"],
};

const instructions = `أنت مستشار مبيعات واتساب لمتجر ${cfg.storeName} في الجزائر. اهدر بالدارجة الجزائرية باختصار ووضوح. استعمل بيانات الشيت فقط وممنوع تخترع السعر أو المقاس أو اللون أو المخزون. إذا المنتج غير متوفر اقترح بديل متوفر. لجمع الطلب اطلب: الاسم، الولاية، البلدية، المنزل أو المكتب، المنتج، اللون، المقاس، الكمية. قبل التسجيل لخص المعلومات واسأل: نثبتلك الطلب؟ لا تعتبره مؤكدا حتى يقول نعم/ثبت/موافق. لا تقل تسجل حتى يعطيك النظام order_id. إذا شكوى حساسة حولها للمسؤول. لا تقل أصلي إلا إذا موجود في البيانات. رابط المتجر الوحيد: ${cfg.storeUrl || "غير مفعّل"}. استعمل "تاريخ المحادثة الأخير" باش تفهم وين وصلت المحادثة ولا تكرر نفس الأسئلة. استعمل "سعر التوصيل" فقط للإجابة عن ثمن التوصيل، وإذا كان غير معروف قول للزبون نحتاجو الولاية والبلدية باش نعطيوه الثمن الصحيح، ولا تخمن ثمن التوصيل أبدا.`;

function publicSession(session) {
  return {
    stage: session.stage,
    customer_name: session.customer_name,
    wilaya: session.wilaya,
    commune: session.commune,
    delivery_type: session.delivery_type,
    product: session.product,
    color: session.color,
    size: session.size,
    quantity: session.quantity,
  };
}

export async function ai(message, session, { products = [], shipping = null } = {}) {
  const input = [
    `رسالة الزبون: ${message}`,
    `الحالة: ${JSON.stringify(publicSession(session))}`,
    `تاريخ المحادثة الأخير: ${JSON.stringify(session.history || [])}`,
    `المنتجات المتوفرة: ${JSON.stringify(products)}`,
    `سعر التوصيل: ${shipping && shipping.matched ? JSON.stringify({ home: shipping.home, office: shipping.office }) : "غير معروف بعد"}`,
  ].join("\n");

  return withRetry(
    async () => {
      const r = await openai.responses.create({
        model: cfg.openai.model,
        instructions,
        input,
        text: { format: { type: "json_schema", name: "sales_action", strict: true, schema } },
      });
      return JSON.parse(r.output_text);
    },
    { retries: 2, label: "openai.responses.create" }
  );
}

// ---------------------------------------------------------------------------
// AI Understanding Layer (DASP-004 SS4.1, Sprint-1 Task 2).
//
// This is a NEW, separate function - added alongside `ai()` above, not a
// replacement for it. `ai()` still has its original {reply, action,
// search_query, updates} contract and server.js still calls it unmodified;
// nothing currently wires `understand()` into the running message-handling
// path. That wiring (via the Deterministic Business Router and the Legacy
// Adapter) is later-task work, per DASP-004 SS4.3's phased migration and the
// Sprint-1 Brief's explicit "without removing any working feature" goal.
//
// Per DASP-004 SS4.1's Rule, this layer's output is ONLY {intent, entities,
// confidence} - it never outputs a reply, an action, a price, a stock
// status, or any other business/commercial decision.
//
// IMPORTANT (see BACKLOG.md, "Confidence concepts" entry): `confidence`
// here is AI LINGUISTIC confidence only - how clearly this layer understood
// the customer's wording. It is NOT, and must never be used as, a
// data-grounded product/variant match confidence. This layer has no Sheets
// access (DASP-004 SS2 Rule) and cannot know whether a product/variant
// actually exists or how many real candidates match it.
// ---------------------------------------------------------------------------

const INTENTS = [
  "product_inquiry", "variant_inquiry", "delivery_inquiry",
  "order_initiate", "order_info_provide", "order_confirm",
  "order_modify", "order_cancel", "general_question",
  "complaint", "greeting", "unknown",
];

const understandingSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    intent: { type: "string", enum: INTENTS },
    entities: {
      type: "object",
      additionalProperties: false,
      properties: {
        productDescription: { type: "string" },
        color: { type: "string" },
        size: { type: "string" },
        wilaya: { type: "string" },
        commune: { type: "string" },
        customerName: { type: "string" },
        phone: { type: "string" },
        deliveryType: { type: "string" },
        quantity: { type: "integer" },
      },
      required: ["productDescription", "color", "size", "wilaya", "commune", "customerName", "phone", "deliveryType", "quantity"],
    },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
  },
  required: ["intent", "entities", "confidence"],
};

const understandingInstructions = `أنت طبقة فهم لغة فقط لمتجر ${cfg.storeName}. مهمتك الوحيدة: تصنيف نية الزبونة، واستخراج المعلومات المذكورة صراحة في رسالتها الحالية، وتقييم مدى وضوح فهمك لهذه الرسالة لغويا. ممنوع عليك: صياغة رد للزبونة، اتخاذ أي قرار تجاري، اختراع سعر أو مقاس أو لون أو توفر منتج، أو افتراض أي معلومة لم تُذكر صراحة.

صنّف النية إلى واحدة فقط من هذه القائمة المغلقة: ${INTENTS.join(", ")}. إذا لم تتطابق الرسالة بوضوح مع أي نية من القائمة، اختر unknown - لا تفرض تصنيفا تقريبيا أبدا.

استخرج فقط ما ذُكر صراحة في الرسالة الحالية؛ اترك أي حقل فارغا "" (أو 0 للكمية) إذا لم يُذكر، ولا تكمّله من معرفتك العامة أو من محادثات سابقة.

confidence يعكس فقط مدى وضوح فهمك اللغوي لهذه الرسالة (هل النية والمعلومات المذكورة واضحة أم غامضة/ناقصة) - وليس تقييما لمدى توفر منتج أو صحة سعر أو عدد المطابقات الحقيقية في المتجر، لأنك لا تملك أي وصول لبيانات المتجر الفعلية.`;

export async function understand(message, context = {}) {
  const input = [
    `رسالة الزبون: ${message}`,
    `سياق مختصر: ${JSON.stringify(context)}`,
  ].join("\n");

  return withRetry(
    async () => {
      const r = await openai.responses.create({
        model: cfg.openai.model,
        instructions: understandingInstructions,
        input,
        text: { format: { type: "json_schema", name: "message_understanding", strict: true, schema: understandingSchema } },
      });
      return JSON.parse(r.output_text);
    },
    { retries: 2, label: "openai.responses.create (understand)" }
  );
}

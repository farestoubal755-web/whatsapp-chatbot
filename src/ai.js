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

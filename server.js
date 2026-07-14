import express from "express";
import { cfg } from "./src/config.js";
import { initStore, searchProducts, getShippingRate, getSession, saveSession, resetProductContext, createOrder } from "./src/store.js";
import { ai } from "./src/ai.js";
import { sendText, verifyWebhookSignature, parseIncoming } from "./src/whatsapp.js";

const app = express();
app.use(express.json({ limit: "2mb", verify: (req, _res, buf) => { req.rawBody = buf; } }));

const HISTORY_TURNS = 8;
const MANAGED_FIELDS = ["customer_name", "wilaya", "commune", "delivery_type", "product", "color", "size", "quantity", "stage"];

// Serializes processing per phone number so two messages arriving close
// together can't both read the session before either writes it back
// (the old code had no such guard, which could silently drop an update).
const phoneQueues = new Map();
function withPhoneQueue(phone, task) {
  const previous = phoneQueues.get(phone) || Promise.resolve();
  const next = previous.then(task, task).finally(() => {
    if (phoneQueues.get(phone) === next) phoneQueues.delete(phone);
  });
  phoneQueues.set(phone, next);
  return next;
}

// WhatsApp can redeliver the same webhook event on timeout; skip messages
// we've already processed instead of double-handling (e.g. double orders).
const seenMessageIds = new Set();
const MAX_SEEN_IDS = 1000;
function alreadyProcessed(id) {
  if (!id) return false;
  if (seenMessageIds.has(id)) return true;
  seenMessageIds.add(id);
  if (seenMessageIds.size > MAX_SEEN_IDS) seenMessageIds.delete(seenMessageIds.values().next().value);
  return false;
}

function mergeUpdates(session, updates = {}) {
  for (const k of MANAGED_FIELDS) {
    if (updates[k] !== undefined && updates[k] !== "" && updates[k] !== 0) session[k] = updates[k];
  }
}

function pushHistory(session, userText, botReply) {
  const history = Array.isArray(session.history) ? session.history : [];
  history.push({ u: userText, b: botReply });
  session.history = history.slice(-HISTORY_TURNS);
}

async function notifyAdmin(phone, text) {
  if (!cfg.adminPhone) {
    console.warn(`[handoff] No ADMIN_PHONE configured. Customer ${phone} needs human follow-up: "${text}"`);
    return;
  }
  await sendText(cfg.adminPhone, `تنبيه: الزبون ${phone} يحتاج متابعة يدوية.\nآخر رسالة: ${text}`);
}

async function handleConfirmOrder(session) {
  const query = [session.product, session.color, session.size].filter(Boolean).join(" ");
  const products = await searchProducts(query);
  const product = products[0];
  const shipping = session.wilaya ? await getShippingRate(session.wilaya, session.commune, session.delivery_type) : { selected: null };

  const missing = [];
  if (!session.customer_name) missing.push("الاسم");
  if (!session.wilaya) missing.push("الولاية");
  if (!session.commune) missing.push("البلدية");
  if (!session.delivery_type || shipping.selected == null) missing.push("نوع التوصيل");
  if (!session.product) missing.push("المنتج");
  if (!session.color) missing.push("اللون");
  if (!session.size) missing.push("المقاس");
  if (!product) missing.push("منتج متوفر مطابق");

  if (missing.length) {
    session.stage = "collecting_order";
    return `باش نثبت الطلب نحتاج: ${missing.join("، ")}.`;
  }

  const order = await createOrder(session, product, shipping.selected);
  resetProductContext(session); // clear product/order fields, keep the reusable customer profile
  session.stage = "ordered";
  return `تم تسجيل طلبك ✅\nرقم الطلب: ${order.id}\nالمجموع: ${order.total} ${cfg.currency}\nنتصلو بيك للتأكيد.`;
}

async function handle(phone, text) {
  const session = await getSession(phone);
  session.last_message = text;

  const shippingPreview = session.wilaya
    ? await getShippingRate(session.wilaya, session.commune, session.delivery_type).catch(() => null)
    : null;

  const decision = await ai(text, session, { shipping: shippingPreview });
  mergeUpdates(session, decision.updates);

  let replyText = decision.reply;

  if (decision.action === "search_products") {
    const query = decision.search_query || [session.product, session.color, session.size].filter(Boolean).join(" ");
    const products = await searchProducts(query);
    const followUp = await ai(text, session, { products, shipping: shippingPreview });
    mergeUpdates(session, followUp.updates);
    replyText = followUp.reply;
  } else if (decision.action === "confirm_order") {
    replyText = await handleConfirmOrder(session);
  } else if (decision.action === "handoff") {
    await notifyAdmin(phone, text).catch((e) => console.error("[admin notify] failed:", e.message));
  }

  pushHistory(session, text, replyText);
  await saveSession(session);
  await sendText(phone, replyText);
}

async function handleUnsupported(phone) {
  await sendText(phone, "توصلنا برسالتك، حاليا نقدر نفهمو غير النص. اكتبلنا طلبك من فضلك 🙏");
}

async function handleFailure(phone, error) {
  console.error(`[handle] error for ${phone}:`, error.message);
  try {
    await sendText(phone, "صرا خطأ تقني عندنا، حاولو عاودو بعد شوية أو تواصلو معانا مباشرة 🙏");
  } catch (sendError) {
    console.error(`[handle] failed to notify ${phone} about the error:`, sendError.message);
  }
}

app.get("/", (_req, res) => res.send(`${cfg.storeName} WhatsApp bot is running.`));
app.get("/health", (_req, res) => res.json({ ok: true }));

app.get("/webhook", (req, res) => {
  if (req.query["hub.mode"] === "subscribe" && req.query["hub.verify_token"] === cfg.verifyToken) {
    return res.status(200).send(req.query["hub.challenge"]);
  }
  return res.sendStatus(403);
});

app.post("/webhook", verifyWebhookSignature(cfg.appSecret), (req, res) => {
  res.sendStatus(200);
  const incoming = parseIncoming(req.body);
  if (!incoming || alreadyProcessed(incoming.id)) return;

  const task = incoming.supported
    ? () => handle(incoming.phone, incoming.text).catch((e) => handleFailure(incoming.phone, e))
    : () => handleUnsupported(incoming.phone).catch((e) => console.error("[unsupported] failed:", e.message));

  withPhoneQueue(incoming.phone, task);
});

initStore()
  .then(() => console.log("Google Sheets ready"))
  .catch((e) => console.error("Google Sheets init failed:", e.message));

app.listen(cfg.port, "0.0.0.0", () => console.log(`Server listening on port ${cfg.port}`));

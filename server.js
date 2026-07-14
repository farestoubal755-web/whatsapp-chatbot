import express from "express";
<<<<<<< HEAD
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
=======
import OpenAI from "openai";
import { google } from "googleapis";

const app = express();
app.use(express.json({ limit: "2mb" }));

const cfg = {
  port: Number(process.env.PORT || 10000),
  verifyToken: process.env.VERIFY_TOKEN,
  whatsappToken: process.env.WHATSAPP_TOKEN,
  phoneNumberId: process.env.PHONE_NUMBER_ID,
  graphVersion: process.env.GRAPH_API_VERSION || "v23.0",
  openaiModel: process.env.OPENAI_MODEL || "gpt-4.1-mini",
  spreadsheetId: process.env.GOOGLE_SHEET_ID,
  productsSheet: process.env.PRODUCTS_SHEET || "PRODUCTS 1",
  shippingSheet: process.env.SHIPPING_SHEET || "SHIPPING",
  ordersSheet: process.env.ORDERS_SHEET || "ORDERS",
  sessionsSheet: process.env.SESSIONS_SHEET || "SESSIONS",
  storeName: process.env.STORE_NAME || "DAR LAFFAIRE",
  storeUrl: process.env.STORE_URL || "",
  currency: process.env.CURRENCY || "DA",
};

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const auth = new google.auth.JWT({
  email: process.env.GOOGLE_CLIENT_EMAIL,
  key: (process.env.GOOGLE_PRIVATE_KEY || "").replace(/\\n/g, "\n"),
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  projectId: process.env.GOOGLE_PROJECT_ID,
});
const sheets = google.sheets({ version: "v4", auth });

const aliases = {
  product: ["product","product name","name","produit","nom","model","modèle","المنتج","موديل"],
  color: ["color","colour","couleur","لون"],
  size: ["size","sizes","taille","pointure","مقاس","المقاس"],
  price: ["price","prix","السعر"],
  stock: ["stock","quantity","qty","quantité","المخزون","كمية"],
  image: ["image","image url","photo","photo url","صورة","رابط الصورة"],
  description: ["description","details","détails","الوصف"],
  wilaya: ["wilaya","province","state","ولاية","الولاية"],
  commune: ["commune","city","municipality","بلدية","البلدية"],
  home: ["home","home delivery","domicile","livraison domicile","توصيل للمنزل"],
  office: ["office","desk","bureau","stop desk","توصيل للمكتب"],
};

const normalize = (v="") => String(v).trim().toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "").replace(/[^\p{L}\p{N}]+/gu," ").trim();
const pick = (row, key) => {
  for (const a of aliases[key] || []) {
    const val = row[normalize(a)];
    if (val !== undefined && val !== "") return val;
  }
  return "";
};
const mapRow = (headers, row) => Object.fromEntries(headers.map((h,i)=>[normalize(h), row[i] ?? ""]));

async function rows(tab) {
  const r = await sheets.spreadsheets.values.get({ spreadsheetId: cfg.spreadsheetId, range: `'${tab}'!A:Z` });
  const v = r.data.values || [];
  if (v.length < 2) return [];
  return v.slice(1).filter(x=>x.some(y=>String(y).trim())).map(x=>mapRow(v[0],x));
}

async function ensureTab(title, headers) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId: cfg.spreadsheetId, fields: "sheets.properties" });
  const exists = (meta.data.sheets || []).some(s=>s.properties?.title===title);
  if (!exists) {
    await sheets.spreadsheets.batchUpdate({ spreadsheetId: cfg.spreadsheetId, requestBody:{ requests:[{addSheet:{properties:{title}}}] } });
    await sheets.spreadsheets.values.update({ spreadsheetId: cfg.spreadsheetId, range:`'${title}'!A1`, valueInputOption:"RAW", requestBody:{values:[headers]} });
  }
}

async function initSheets() {
  await ensureTab(cfg.ordersSheet,["created_at","order_id","customer_name","phone","wilaya","commune","delivery_type","product","color","size","quantity","unit_price","shipping_price","total","status","source","notes"]);
  await ensureTab(cfg.sessionsSheet,["phone","updated_at","stage","customer_name","wilaya","commune","delivery_type","product","color","size","quantity","last_message"]);
}

async function searchProducts(query) {
  const q = normalize(query).split(" ").filter(Boolean);
  return (await rows(cfg.productsSheet)).map(r=>({
    product:pick(r,"product"), color:pick(r,"color"), size:pick(r,"size"),
    price:Number(String(pick(r,"price")).replace(/[^\d.]/g,""))||0,
    stock:Number(String(pick(r,"stock")).replace(/[^\d.-]/g,""))||0,
    image:pick(r,"image"), description:pick(r,"description")
  })).filter(p=>p.stock>0 && (q.length===0 || q.every(t=>normalize(Object.values(p).join(" ")).includes(t)))).slice(0,8);
}

async function shipping(wilaya, commune, type) {
  const all = await rows(cfg.shippingSheet), w=normalize(wilaya), c=normalize(commune);
  const r = all.find(x=>normalize(pick(x,"wilaya"))===w && (!c || normalize(pick(x,"commune"))===c)) || all.find(x=>normalize(pick(x,"wilaya"))===w);
  if (!r) return {selected:0};
  const home=Number(String(pick(r,"home")).replace(/[^\d.]/g,""))||0;
  const office=Number(String(pick(r,"office")).replace(/[^\d.]/g,""))||0;
  return {home,office,selected:/office|bureau|مكتب/i.test(type||"")?office:home};
}

async function getSession(phone) {
  const r = await sheets.spreadsheets.values.get({spreadsheetId:cfg.spreadsheetId,range:`'${cfg.sessionsSheet}'!A:L`});
  const v=r.data.values||[];
  if(v.length<2) return {phone,stage:"browsing",quantity:1};
  for(let i=v.length-1;i>=1;i--) if(String(v[i][0])===String(phone)) {
    const m=mapRow(v[0],v[i]);
    return {phone,stage:m.stage||"browsing",customer_name:m.customer_name||"",wilaya:m.wilaya||"",commune:m.commune||"",delivery_type:m.delivery_type||"",product:m.product||"",color:m.color||"",size:m.size||"",quantity:Number(m.quantity)||1,last_message:m.last_message||"",rowNumber:i+1};
  }
  return {phone,stage:"browsing",quantity:1};
}

async function saveSession(s) {
  const values=[[s.phone,new Date().toISOString(),s.stage||"browsing",s.customer_name||"",s.wilaya||"",s.commune||"",s.delivery_type||"",s.product||"",s.color||"",s.size||"",s.quantity||1,s.last_message||""]];
  if(s.rowNumber) await sheets.spreadsheets.values.update({spreadsheetId:cfg.spreadsheetId,range:`'${cfg.sessionsSheet}'!A${s.rowNumber}:L${s.rowNumber}`,valueInputOption:"USER_ENTERED",requestBody:{values}});
  else await sheets.spreadsheets.values.append({spreadsheetId:cfg.spreadsheetId,range:`'${cfg.sessionsSheet}'!A:L`,valueInputOption:"USER_ENTERED",insertDataOption:"INSERT_ROWS",requestBody:{values}});
}

const schema={type:"object",additionalProperties:false,properties:{reply:{type:"string"},action:{type:"string",enum:["reply","search_products","confirm_order","handoff"]},search_query:{type:"string"},updates:{type:"object",additionalProperties:false,properties:{customer_name:{type:"string"},wilaya:{type:"string"},commune:{type:"string"},delivery_type:{type:"string"},product:{type:"string"},color:{type:"string"},size:{type:"string"},quantity:{type:"integer"},stage:{type:"string"}},required:["customer_name","wilaya","commune","delivery_type","product","color","size","quantity","stage"]}},required:["reply","action","search_query","updates"]};

const instructions=`أنت مستشار مبيعات واتساب لمتجر ${cfg.storeName} في الجزائر. اهدر بالدارجة الجزائرية باختصار ووضوح. استعمل بيانات الشيت فقط وممنوع تخترع السعر أو المقاس أو اللون أو المخزون. إذا المنتج غير متوفر اقترح بديل متوفر. لجمع الطلب اطلب: الاسم، الولاية، البلدية، المنزل أو المكتب، المنتج، اللون، المقاس، الكمية. قبل التسجيل لخص المعلومات واسأل: نثبتلك الطلب؟ لا تعتبره مؤكدا حتى يقول نعم/ثبت/موافق. لا تقل تسجل حتى يعطيك النظام order_id. إذا شكوى حساسة حولها للمسؤول. لا تقل أصلي إلا إذا موجود في البيانات. رابط المتجر الوحيد: ${cfg.storeUrl||"غير مفعّل"}.`;

async function ai(message,session,products=[]) {
  const r=await openai.responses.create({model:cfg.openaiModel,instructions,input:`رسالة الزبون: ${message}\nالحالة: ${JSON.stringify(session)}\nالمنتجات المتوفرة: ${JSON.stringify(products)}`,text:{format:{type:"json_schema",name:"sales_action",strict:true,schema}}});
  return JSON.parse(r.output_text);
}

function merge(s,u={}) { for(const k of ["customer_name","wilaya","commune","delivery_type","product","color","size","quantity","stage"]) if(u[k]!==undefined && u[k]!=="" && u[k]!==0) s[k]=u[k]; return s; }

async function sendText(to,body) {
  const r=await fetch(`https://graph.facebook.com/${cfg.graphVersion}/${cfg.phoneNumberId}/messages`,{method:"POST",headers:{Authorization:`Bearer ${cfg.whatsappToken}`,"Content-Type":"application/json"},body:JSON.stringify({messaging_product:"whatsapp",recipient_type:"individual",to,type:"text",text:{preview_url:true,body}})});
  if(!r.ok) throw new Error(`WhatsApp ${r.status}: ${await r.text()}`);
}

async function createOrder(s,p) {
  const sh=await shipping(s.wilaya,s.commune,s.delivery_type), q=Number(s.quantity)||1, id=`DL-${Date.now()}`;
  const total=p.price*q+sh.selected;
  await sheets.spreadsheets.values.append({spreadsheetId:cfg.spreadsheetId,range:`'${cfg.ordersSheet}'!A:Q`,valueInputOption:"USER_ENTERED",insertDataOption:"INSERT_ROWS",requestBody:{values:[[new Date().toISOString(),id,s.customer_name,s.phone,s.wilaya,s.commune,s.delivery_type,p.product,s.color||p.color,s.size||p.size,q,p.price,sh.selected,total,"NEW","WhatsApp Bot",""]]}});
  return {id,total};
}

async function handle(phone,text) {
  let s=await getSession(phone); s.last_message=text;
  const a=await ai(text,s); merge(s,a.updates);
  if(a.action==="search_products") { const ps=await searchProducts(a.search_query||[s.product,s.color,s.size].join(" ")); const b=await ai(text,s,ps); merge(s,b.updates); await saveSession(s); return sendText(phone,b.reply); }
  if(a.action==="confirm_order") {
    const ps=await searchProducts([s.product,s.color,s.size].filter(Boolean).join(" ")), p=ps[0];
    const missing=[]; if(!s.customer_name)missing.push("الاسم"); if(!s.wilaya)missing.push("الولاية"); if(!s.commune)missing.push("البلدية"); if(!s.delivery_type)missing.push("نوع التوصيل"); if(!s.product)missing.push("المنتج"); if(!s.color)missing.push("اللون"); if(!s.size)missing.push("المقاس"); if(!p)missing.push("منتج متوفر مطابق");
    if(missing.length){s.stage="collecting_order";await saveSession(s);return sendText(phone,`باش نثبت الطلب نحتاج: ${missing.join("، ")}.`)}
    const o=await createOrder(s,p);s.stage="ordered";await saveSession(s);return sendText(phone,`تم تسجيل طلبك ✅\nرقم الطلب: ${o.id}\nالمجموع: ${o.total} ${cfg.currency}\nنتصلو بيك للتأكيد.`);
  }
  await saveSession(s); return sendText(phone,a.reply);
}

function incoming(body){const m=body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];if(!m)return null;const text=m.text?.body||m.button?.text||m.interactive?.button_reply?.title||m.interactive?.list_reply?.title||"";return text?{phone:m.from,text}:null;}

app.get("/",(_q,r)=>r.send(`${cfg.storeName} WhatsApp bot is running.`));
app.get("/health",(_q,r)=>r.json({ok:true}));
app.get("/webhook",(q,r)=>q.query["hub.mode"]==="subscribe"&&q.query["hub.verify_token"]===cfg.verifyToken?r.status(200).send(q.query["hub.challenge"]):r.sendStatus(403));
app.post("/webhook",(q,r)=>{r.sendStatus(200);const x=incoming(q.body);if(x)handle(x.phone,x.text).catch(e=>console.error("Message processing error",e));});

initSheets().then(()=>console.log("Google Sheets ready")).catch(e=>console.error("Google Sheets init failed",e));
app.listen(cfg.port,"0.0.0.0",()=>console.log(`Server listening on port ${cfg.port}`));
>>>>>>> 8138dc493662529a0c00910e047c31398ffbe85b

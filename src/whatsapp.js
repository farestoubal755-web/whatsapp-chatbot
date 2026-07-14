import crypto from "node:crypto";
import { cfg } from "./config.js";
import { withRetry } from "./retry.js";

const MAX_WHATSAPP_TEXT_LEN = 4096;
const UNSUPPORTED_TYPES = new Set(["image", "audio", "video", "document", "sticker", "location", "contacts"]);

export function truncateForWhatsApp(text) {
  const body = text || "";
  return body.length > MAX_WHATSAPP_TEXT_LEN ? body.slice(0, MAX_WHATSAPP_TEXT_LEN - 1) + "…" : body;
}

export async function sendText(to, body) {
  const text = truncateForWhatsApp(body);
  await withRetry(
    async () => {
      const r = await fetch(`https://graph.facebook.com/${cfg.graphVersion}/${cfg.phoneNumberId}/messages`, {
        method: "POST",
        headers: { Authorization: `Bearer ${cfg.whatsappToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ messaging_product: "whatsapp", recipient_type: "individual", to, type: "text", text: { preview_url: true, body: text } }),
      });
      if (!r.ok) {
        const detail = await r.text().catch(() => "");
        const err = new Error(`WhatsApp send failed (${r.status}): ${detail}`);
        err.status = r.status;
        throw err;
      }
    },
    { retries: 2, label: `whatsapp send to ${to}` }
  );
}

// Verifies Meta's X-Hub-Signature-256 header against the raw request body.
// If APP_SECRET isn't configured, verification is skipped (a startup
// warning is logged in config.js) so existing deployments don't break the
// moment this ships - but it should be set for any real deployment.
export function verifyWebhookSignature(appSecret) {
  return (req, res, next) => {
    if (!appSecret) return next();
    const header = req.get("x-hub-signature-256") || "";
    const sigHex = header.split("=")[1];
    if (!sigHex || !req.rawBody) return res.sendStatus(401);
    const expectedHex = crypto.createHmac("sha256", appSecret).update(req.rawBody).digest("hex");
    const a = Buffer.from(sigHex, "hex");
    const b = Buffer.from(expectedHex, "hex");
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.sendStatus(401);
    next();
  };
}

export function parseIncoming(body) {
  const m = body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
  if (!m) return null;
  const phone = m.from;
  const id = m.id;
  const text = m.text?.body || m.button?.text || m.interactive?.button_reply?.title || m.interactive?.list_reply?.title || "";
  if (text) return { id, phone, text, supported: true };
  if (UNSUPPORTED_TYPES.has(m.type)) return { id, phone, text: "", supported: false, type: m.type };
  return null;
}

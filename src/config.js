import "dotenv/config";

const REQUIRED = [
  "VERIFY_TOKEN",
  "WHATSAPP_TOKEN",
  "PHONE_NUMBER_ID",
  "OPENAI_API_KEY",
  "GOOGLE_CLIENT_EMAIL",
  "GOOGLE_PRIVATE_KEY",
  "GOOGLE_SHEET_ID",
];

const missing = REQUIRED.filter((k) => !process.env[k]);
if (missing.length) {
  console.warn(`[config] Missing environment variables: ${missing.join(", ")}. The bot will not work correctly until these are set.`);
}
if (!process.env.APP_SECRET) {
  console.warn("[config] APP_SECRET not set - webhook signature verification is DISABLED. Set it to your Meta App Secret to secure /webhook.");
}

export const cfg = {
  port: Number(process.env.PORT || 10000),
  verifyToken: process.env.VERIFY_TOKEN,
  whatsappToken: process.env.WHATSAPP_TOKEN,
  phoneNumberId: process.env.PHONE_NUMBER_ID,
  graphVersion: process.env.GRAPH_API_VERSION || "v23.0",
  appSecret: process.env.APP_SECRET || "",
  databaseUrl: process.env.DATABASE_URL || "",
  adminPhone: process.env.ADMIN_PHONE || "",
  sessionTtlHours: Number(process.env.SESSION_TTL_HOURS || 12),
  storeName: process.env.STORE_NAME || "DAR LAFFAIRE",
  storeUrl: process.env.STORE_URL || "",
  currency: process.env.CURRENCY || "DA",
  openai: {
    apiKey: process.env.OPENAI_API_KEY,
    model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
  },
  google: {
    clientEmail: process.env.GOOGLE_CLIENT_EMAIL,
    privateKey: process.env.GOOGLE_PRIVATE_KEY || "",
    projectId: process.env.GOOGLE_PROJECT_ID,
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
  },
  sheets: {
    products: process.env.PRODUCTS_SHEET || "PRODUCTS 1",
    shipping: process.env.SHIPPING_SHEET || "SHIPPING",
    orders: process.env.ORDERS_SHEET || "ORDERS",
    sessions: process.env.SESSIONS_SHEET || "SESSIONS",
  },
  sandboxOrderPilot: {
    enabled: process.env.SANDBOX_ORDER_PILOT_ENABLED === "true",
    phoneAllowlistRaw: process.env.SANDBOX_ORDER_PILOT_PHONE_ALLOWLIST || "",
  },
};

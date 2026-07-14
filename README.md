# WhatsApp Chatbot

Render settings:
- Language: Node
- Build Command: `npm install`
- Start Command: `npm start`
- Webhook URL: `https://YOUR-RENDER-DOMAIN/webhook`

Add the variables from `.env.example` in Render. Never upload real tokens to GitHub.
<<<<<<< HEAD

## Structure
- `server.js` - Express app, webhook routes, per-conversation orchestration.
- `src/config.js` - environment configuration and startup checks.
- `src/store.js` - Google Sheets-backed products, shipping, sessions, orders.
- `src/sheetsClient.js` - Sheets API access with retries and short-lived caching.
- `src/ai.js` - OpenAI Responses API call and system prompt.
- `src/whatsapp.js` - sending messages, webhook signature verification, incoming message parsing.
- `src/retry.js`, `src/utils.js` - shared helpers.

## Security
Set `APP_SECRET` (your Meta App Secret) so the bot verifies the `X-Hub-Signature-256` header on every webhook call. Without it, anyone who finds your webhook URL could POST fake messages.

## New optional settings
- `ADMIN_PHONE` - WhatsApp number notified when a conversation is handed off to a human.
- `SESSION_TTL_HOURS` - idle time after which a customer's next message starts a fresh conversation (default 12h).
=======
>>>>>>> 8138dc493662529a0c00910e047c31398ffbe85b

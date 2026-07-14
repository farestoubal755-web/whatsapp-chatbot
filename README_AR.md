# DAR LAFFAIRE WhatsApp Bot v2

بوت جديد يربط مباشرة WhatsApp + OpenAI + Google Sheets + Render.

## الوظائف
- الرد بالدارجة الجزائرية.
- قراءة المنتجات من `PRODUCTS 1`.
- قراءة التوصيل من `SHIPPING`.
- حفظ المحادثات في `SESSIONS`.
- تسجيل الطلبات المؤكدة في `ORDERS`.
- عدم اختراع معلومات غير موجودة في الشيت.

## أعمدة مقترحة
### PRODUCTS 1
Name | Color | Size | Price | Stock | Image | Description

### SHIPPING
Wilaya | Commune | Home | Office

## Render
Build command: `npm install`
Start command: `npm start`

أضف كل المتغيرات الموجودة في `.env.example`.

## Meta Webhook
Callback URL: `https://YOUR-RENDER-URL/webhook`
Verify token: نفس `VERIFY_TOKEN`
Subscribe: `messages`

## أمان
المفتاح الخاص ظهر في صور المحادثة. احذف المفتاح القديم من Google Cloud وأنشئ مفتاحا جديدا، ثم حدّث `GOOGLE_PRIVATE_KEY` في Render. (تأكد أن هذا صار فعلا قبل ما تنشر الكود.)

أضف `APP_SECRET` (App Secret ديال Meta) باش السيرفر يتحقق أن كل طلب جاي فعلا من واتساب (توقيع `X-Hub-Signature-256`). بدون هذا المتغير، أي حد عندو رابط الـ webhook يقدر يبعث رسائل وهمية.

## متغيرات جديدة (اختيارية)
- `ADMIN_PHONE`: رقم واتساب يتوصل بتنبيه إلى المسؤول كي البوت يحول محادثة لشخص حقيقي.
- `SESSION_TTL_HOURS`: بعد قداه ديال الوقت بلا رسائل تعتبر المحادثة الجاية جديدة وتمسح معلومات الطلب القديمة (افتراضيا 12 ساعة).

## بنية الكود
الكود ولا مقسم على عدة ملفات صغيرة تحت `src/` (config, store, sheetsClient, ai, whatsapp, retry, utils) باش يبقى كل جزء واضح ومنفصل، و`server.js` يبقى غير نقطة التجميع والـ routes.

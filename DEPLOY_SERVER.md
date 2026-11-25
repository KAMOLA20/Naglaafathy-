# دليل رفع وتشغيل منصة الأستاذة نجلاء فتحي على سيرفر مجاني والربط مع Odoo

هذا المشروع جاهز للتشغيل الكامل (الواجهة الأمامية + الخادم الخلفي + WebSocket المحادثة الفورية) من منفذ واحد (`PORT` أو `3000`).

---

## 1) هل ينفع سيرفر مجاني؟ وما الأفضل؟

نعم، ينفع السيرفر المجاني لتشغيل المنصة بالكامل، ولكن مع نقطة تقنية مهمة حول **حفظ البيانات**:

- **Render Free / Koyeb Free**: مجاني وسهل جداً ويعمل بضغطة زر عبر ملف `render.yaml` أو `Dockerfile`.
  - *ملاحظة هامة*: الاستضافات المجانية تنام بعد ~15 دقيقة من عدم الاستخدام وتُفرّغ التخزين المحلي عند إعادة التشغيل.
  - **الحل المجاني الدائم للبيانات**: أضف متغير البيئة `DATABASE_URL` من **Neon.tech** أو **Supabase** (مجاني بدون فيزا) أو `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN`، وسيحفظ السيرفر جميع بيانات الطلاب والمدفوعات والتقييمات سحابياً بشكل دائم.
- **Oracle Cloud Always Free VPS**: سيرفر Linux مجاني دائم (لا ينام ولا يمسح الملفات المحلية).

---

## 2) هل ينفع الرفع على أودو (Odoo) وكيف يتم الربط؟

نظام **Odoo** مبني على Python وPostgreSQL لإدارة الموارد والمواقع، لذلك **لا يمكن تركيب تطبيق Node.js/React كـ Module داخلي داخل Odoo** بدون إعادة برمجته بلغة Python.

**الطريقة الصحيحة والمعتمدة للربط مع Odoo Website:**
1. استضافة المنصة على رابط مستقل (مثل الرابط المنشور حالياً أو استضافة Render / Koyeb المجانية).
2. داخل لوحة تحكم **Odoo → Website**:
   - **الطريقة الأولى (تضمين داخل صفحة Odoo):** أنشئ صفحة جديدة واسحب كتلة **Embed Code / HTML** وألصق كود الـ `<iframe>` الموجود داخل **لوحة المعلم ← إعدادات المنصة ← الربط مع Odoo**.
   - **الطريقة الثانية (زر في القائمة العلوية لـ Odoo):** أضف عنصر قائمة من `Website → Site → Menu Editor` يشير مباشرة إلى رابط المنصة.

---

## 3) خطوات الرفع المجاني على Render (الأسهل بدون سطر أوامر)

1. حمّل حزمة السيرفر النظيفة (`platform-naglaa-fathi-server.tar.gz`) من **لوحة المعلم ← إعدادات المنصة** وفك ضغطها وارفعها على مستودع GitHub خاص بك.
2. افتح **Render.com** واختر **New → Blueprint** واربط مستودع GitHub (سيقرأ ملف `render.yaml` تلقائياً).
   - أو اختر **New → Web Service** بالإعدادات التالية:
     - **Build Command:** `npm install --include=dev && npm run build`
     - **Start Command:** `NODE_ENV=production node server.ts`
     - **Health Check Path:** `/api/health`
3. أضف متغير البيئة `DATABASE_URL` (من Neon.tech المجاني) حتى تبقى البيانات محفوظة دائماً.

---

## 4) التشغيل عبر Docker (Koyeb / Hugging Face Spaces / VPS)

```bash
docker build -t naglaa-academy .
docker run -d -p 3000:3000 -e PORT=3000 -e NODE_ENV=production naglaa-academy
```

---

## 5) التشغيل على سيرفر Linux VPS خاص

```bash
tar -xzf platform-naglaa-fathi-server.tar.gz -C naglaa-academy
cd naglaa-academy
cp .env.example .env
npm install --include=dev
npm run build
NODE_ENV=production node server.ts
```
*(أو باستخدام PM2 لإبقائها تعمل في الخلفية: `NODE_ENV=production pm2 start server.ts --interpreter node --name naglaa-academy`)*

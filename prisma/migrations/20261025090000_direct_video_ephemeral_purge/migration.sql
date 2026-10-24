-- HRMP — (بلاغ المالك 2026-10-25) الفيديو المرسل يمسح بعد استهلاكه مثل الصوتيات
-- أعمدة المسح على DirectMessage: purgedAt/purgedBy + فهرس المسح الكسول (TTL 72 ساعة)
-- الحمولة (media BLOB) تُفرَّغ فورًا عند الاستهلاك والبث بعدها 410 Gone —
-- السجل الوصفي (مرسل/متلقٍّ/مدة/أوقات) يبقى للتدقيق كما في الصوتيات.
ALTER TABLE "DirectMessage" ADD COLUMN "purgedAt" DATETIME;
ALTER TABLE "DirectMessage" ADD COLUMN "purgedBy" TEXT;
CREATE INDEX "DirectMessage_purgedAt_idx" ON "DirectMessage"("purgedAt");

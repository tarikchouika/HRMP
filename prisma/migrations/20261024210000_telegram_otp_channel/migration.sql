-- HRMP — قناة OTP عبر Telegram (طلب المالك 2026-10-24)
-- ربط حساب الباحث بمحادثة Telegram عبر توكن أحادي قصير العمر، ثم تحقق مستقل
-- (telegramVerifiedAt) يُقبل كعامل ثانٍ بديل عن التحقق بالهاتف/SMS.

-- إضافة حقول الربط والتحقق إلى JobSeeker
ALTER TABLE "JobSeeker" ADD COLUMN "telegramChatId" TEXT;
ALTER TABLE "JobSeeker" ADD COLUMN "telegramUsername" TEXT;
ALTER TABLE "JobSeeker" ADD COLUMN "telegramLinkTokenHash" TEXT;
ALTER TABLE "JobSeeker" ADD COLUMN "telegramLinkTokenExpiresAt" DATETIME;
ALTER TABLE "JobSeeker" ADD COLUMN "telegramLinkedAt" DATETIME;
ALTER TABLE "JobSeeker" ADD COLUMN "telegramVerifiedAt" DATETIME;

-- chat id فريد: محادثة Telegram واحدة لا تُربط بأكثر من باحث
CREATE UNIQUE INDEX "JobSeeker_telegramChatId_key" ON "JobSeeker"("telegramChatId");

-- توكن الربط أحادي الاستخدام (يُخزَّن هاشه فقط)
CREATE UNIQUE INDEX "JobSeeker_telegramLinkTokenHash_key" ON "JobSeeker"("telegramLinkTokenHash");

// HRMP — ربط حساب الباحث بمحادثة Telegram (قناة OTP بديلة للهاتف)
// ---------------------------------------------------------------------------
// التوكن عشوائي 32 بايت (base64url، 43 محرفًا < حد Telegram 64) ويُخزَّن هاشه
// فقط مع مدة 15 دقيقة. لا يكشف تسريب القاعدة توكن ربط صالحًا. الربط يتم حين
// يرسل المستخدم /start <token> للبوت؛ والتحقق من الملكية يتم بإرسال OTP إلى
// نفس المحادثة ثم إدخاله في الموقع (telegramVerifiedAt).
import { createHash, randomBytes } from "node:crypto";

declare const process: { env: Record<string, string | undefined> };

export const TELEGRAM_LINK_TTL_MS = 15 * 60 * 1000;

/** هاش التوكن — ملح مشتق من AUTH_SECRET كما في OTP (بلا سر إضافي) */
export function telegramLinkHash(token: string): string {
  const salt = (process.env.AUTH_SECRET ?? "otp-salt").slice(0, 32);
  return createHash("sha256").update(`${salt}:telegram-link:${token}`).digest("hex");
}

export function createTelegramLinkToken(): { token: string; hash: string; expiresAt: Date } {
  const token = randomBytes(32).toString("base64url");
  return {
    token,
    hash: telegramLinkHash(token),
    expiresAt: new Date(Date.now() + TELEGRAM_LINK_TTL_MS),
  };
}

/** رابط فتح البوت مع حمولة /start — اسم البوت من البيئة أو الافتراضي */
export function telegramBotDeepLink(token: string): string {
  const bot = process.env.TELEGRAM_BOT_USERNAME?.trim() || "hrmpotp_bot";
  return `https://t.me/${bot}?start=${encodeURIComponent(token)}`;
}

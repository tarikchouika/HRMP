// HRMP — خدمة رموز التحقق OTP للتسجيل العام (طلب المالك 2026-10-24)
// ---------------------------------------------------------------------------
// «التأكد الألي من رقم هاتفه و الإيمايل»: رمز 6 أرقام لكل قناة، يُخزَّن هاشه
// (SHA-256 + ملح) لا الرمز ذاته، عمره 10 دقائق، أحادي الاستخدام، بحد 5 محاولات
// ثم يُبطَل. الإرسال عبر مزوّدَين قابلَين للضبط من البيئة:
//   البريد: SMTP عبر nodemailer (SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_PASS/SMTP_FROM)
//   الهاتف: بوابة HTTP عامة (SMS_WEBHOOK_URL + SMS_WEBHOOK_TOKEN) تقبل أي مزوّد
//           مغربي (POST JSON {phone, message}) — مرونة كاملة للمالك.
//   تيليغرام: البوت نفسه (TELEGRAM_BOT_TOKEN) بعد ربط محادثة الباحث — بديل عن
//           SMS حين لا يتوفر مزوّد هاتف (طلب المالك 2026-10-24).
// بلا مزوّد مضبوط في الإنتاج: رفض صريح 503 برسالة إدارية واضحة (لا حلقة أمنية
// تُختصر). وفي وضع الاختيار الصريح OTP_DEV_SHOW_CODE=1 يُعاد الرمز في الاستجابة
// (تجربة محلية بلا مزوّد — موثّق بتحذير في السجل والواجهة).
import { createHash, randomInt } from "node:crypto";
import nodemailer from "nodemailer";
import { db } from "@/lib/db";
import { rateLimit } from "@/lib/rate-limit";
import { sendTelegramTo } from "@/lib/telegram";
import { getDictionary, tServer } from "@/i18n/get-dictionary";
import type { Locale } from "@/i18n/config";
import { OTP_CODE_DIGITS, OTP_MAX_ATTEMPTS, OTP_TTL_MS } from "./types";

export type OtpChannel = "email" | "phone" | "telegram";

export type SendResult =
  | { ok: true; devCode?: string }
  | { ok: false; code: "rate_limited" | "provider_not_configured" | "provider_error"; retryAfterMs?: number };

function hashCode(target: string, code: string): string {
  // ملح مشتق من سر الجلسة نفسه: كافٍ لتمييز الرموز دون تخزين سر إضافي، ولا
  // يُشتق منه الرمز أبدًا (اتجاه واحد). الهدف: تسريب قاعدة لا يكشف رموزًا نشطة.
  const salt = (process.env.AUTH_SECRET ?? "otp-salt").slice(0, 32);
  return createHash("sha256").update(`${salt}:${target}:${code}`).digest("hex");
}

export function isDevShowCode(): boolean {
  return process.env.OTP_DEV_SHOW_CODE === "1";
}

// ─── المزوّدات ────────────────────────────────────────────────────────────────

function smtpConfigured(): boolean {
  return !!(process.env.SMTP_HOST && process.env.SMTP_PORT);
}

async function sendEmailOtp(to: string, code: string, locale: Locale): Promise<boolean> {
  const dict = getDictionary(locale);
  const subject = tServer(dict, "jobs.otp.emailSubject", { code });
  const body = tServer(dict, "jobs.otp.emailBody", { code });
  try {
    const transport = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT ?? 587),
      secure: process.env.SMTP_SECURE === "true" || Number(process.env.SMTP_PORT) === 465,
      auth:
        process.env.SMTP_USER && process.env.SMTP_PASS
          ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
          : undefined,
    });
    await transport.sendMail({
      from: process.env.SMTP_FROM ?? process.env.SMTP_USER ?? `HRMP <no-reply@${process.env.SMTP_HOST}>`,
      to,
      subject,
      text: body,
    });
    return true;
  } catch (e) {
    console.error("[HRMP][otp] فشل إرسال بريد OTP:", e instanceof Error ? e.message : e);
    return false;
  }
}

function smsWebhookConfigured(): boolean {
  return !!process.env.SMS_WEBHOOK_URL;
}

async function sendSmsOtp(phoneE164: string, code: string, locale: Locale): Promise<boolean> {
  const dict = getDictionary(locale);
  const message = tServer(dict, "jobs.otp.smsBody", { code });
  try {
    const res = await fetch(process.env.SMS_WEBHOOK_URL!, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(process.env.SMS_WEBHOOK_TOKEN
          ? { authorization: `Bearer ${process.env.SMS_WEBHOOK_TOKEN}` }
          : {}),
      },
      body: JSON.stringify({ phone: `+${phoneE164}`, message }),
      signal: AbortSignal.timeout(10_000),
    });
    return res.ok;
  } catch (e) {
    console.error("[HRMP][otp] فشل إرسال SMS OTP:", e instanceof Error ? e.message : e);
    return false;
  }
}

function telegramConfigured(): boolean {
  return !!process.env.TELEGRAM_BOT_TOKEN;
}

async function sendTelegramOtp(chatId: string, code: string, locale: Locale): Promise<boolean> {
  const dict = getDictionary(locale);
  const message = tServer(dict, "jobs.otp.telegramBody", { code });
  return sendTelegramTo(chatId, message);
}

// ─── الإصدار والتحقق ──────────────────────────────────────────────────────────

/** إصدار وإرسال رمز لقناة (بريد/هاتف) — حدود المعدل: 3 لكل هدف/10د + 10 لكل IP/ساعة */
export async function issueAndSendOtp(
  channel: OtpChannel,
  target: string,
  locale: Locale,
  clientIp: string | null
): Promise<SendResult> {
  const perTarget = rateLimit(`otp:${channel}:${target}`, 3, 10 * 60 * 1000);
  if (!perTarget.allowed) {
    return { ok: false, code: "rate_limited", retryAfterMs: perTarget.retryAfterMs };
  }
  const perIp = rateLimit(`otp-ip:${clientIp ?? "unknown"}`, 10, 60 * 60 * 1000);
  if (!perIp.allowed) {
    return { ok: false, code: "rate_limited", retryAfterMs: perIp.retryAfterMs };
  }

  const code = String(randomInt(0, 10 ** OTP_CODE_DIGITS)).padStart(OTP_CODE_DIGITS, "0");
  const expiresAt = new Date(Date.now() + OTP_TTL_MS);

  // أي رموز سابقة غير مستهلكة لنفس القناة/الهدف تُستهلك الآن (الرمز الجديد هو النافذ)
  await db.otpCode.updateMany({
    where: { channel, target, consumedAt: null },
    data: { consumedAt: new Date() },
  });
  await db.otpCode.create({
    data: { channel, target, codeHash: hashCode(target, code), expiresAt },
  });

  const providerConfigured =
    channel === "email" ? smtpConfigured() : channel === "phone" ? smsWebhookConfigured() : telegramConfigured();
  if (!providerConfigured) {
    if (isDevShowCode()) {
      console.warn(
        `[HRMP][otp] OTP_DEV_SHOW_CODE=1 — رمز ${channel} يُعاد في الاستجابة (وضع تجربة بلا مزوّد؛ لا يُستعمل في إنتاج حقيقي أبدًا)`
      );
      return { ok: true, devCode: code };
    }
    console.error(
      `[HRMP][otp] لا مزوّد مضبوط للقناة ${channel} — راجع .env.example (SMTP_* للبريد / SMS_WEBHOOK_* للهاتف / TELEGRAM_BOT_TOKEN لتيليغرام)`
    );
    return { ok: false, code: "provider_not_configured" };
  }

  const sent =
    channel === "email"
      ? await sendEmailOtp(target, code, locale)
      : channel === "phone"
        ? await sendSmsOtp(target, code, locale)
        : await sendTelegramOtp(target, code, locale);
  if (!sent) return { ok: false, code: "provider_error" };
  return { ok: true };
}

export type VerifyOutcome = "ok" | "not_found" | "expired" | "too_many_attempts" | "wrong_code";

/** تحقق رمز لقناة — أحادي الاستخدام مع عدّاد محاولات */
export async function verifyOtp(channel: OtpChannel, target: string, code: string): Promise<VerifyOutcome> {
  const row = await db.otpCode.findFirst({
    where: { channel, target, consumedAt: null },
    orderBy: { createdAt: "desc" },
  });
  if (!row) return "not_found";
  if (row.expiresAt.getTime() < Date.now()) {
    await db.otpCode.update({ where: { id: row.id }, data: { consumedAt: new Date() } });
    return "expired";
  }
  if (row.attempts >= OTP_MAX_ATTEMPTS) {
    await db.otpCode.update({ where: { id: row.id }, data: { consumedAt: new Date() } });
    return "too_many_attempts";
  }
  if (row.codeHash !== hashCode(target, code.trim())) {
    await db.otpCode.update({ where: { id: row.id }, data: { attempts: { increment: 1 } } });
    return "wrong_code";
  }
  await db.otpCode.update({ where: { id: row.id }, data: { consumedAt: new Date() } });
  return "ok";
}

/** مسح رموز المتقادمة (استدعاء كسول من مسارات القنال — يمنع تراكم الجدول) */
export async function purgeExpiredOtps(): Promise<void> {
  try {
    await db.otpCode.deleteMany({ where: { expiresAt: { lt: new Date(Date.now() - 60 * 60 * 1000) } } });
  } catch {
    /* مسح كسول — فشله لا يوقف المسار الأصلي */
  }
}

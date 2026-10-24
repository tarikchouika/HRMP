// HRMP — إرسال رمز تحقق OTP للباحث (بريد/هاتف): الهدف من الجلسة لا من الطلب
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requestMeta } from "@/lib/auth/session";
import { getSeekerSession } from "@/lib/recruitment/seeker-auth";
import { issueAndSendOtp, purgeExpiredOtps } from "@/lib/recruitment/otp";
import { normalizeEmail, normalizeMoroccanPhone } from "@/lib/recruitment/types";

const schema = z.object({ channel: z.enum(["email", "phone", "telegram"]) });

export async function POST(req: NextRequest) {
  try {
    const session = await getSeekerSession();
    if (!session) {
      return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
    }
    const body = schema.safeParse(await req.json().catch(() => null));
    if (!body.success) {
      return NextResponse.json({ error: "invalid_input" }, { status: 400 });
    }

    const seeker = await db.jobSeeker.findUnique({
      where: { id: session.sub },
      select: {
        email: true,
        phone: true,
        emailVerifiedAt: true,
        phoneVerifiedAt: true,
        telegramChatId: true,
        telegramVerifiedAt: true,
        locale: true,
      },
    });
    if (!seeker) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    if (body.data.channel === "email" && seeker.emailVerifiedAt) {
      return NextResponse.json({ error: "already_verified" }, { status: 409 });
    }
    if (body.data.channel === "phone" && seeker.phoneVerifiedAt) {
      return NextResponse.json({ error: "already_verified" }, { status: 409 });
    }
    if (body.data.channel === "telegram" && seeker.telegramVerifiedAt) {
      return NextResponse.json({ error: "already_verified" }, { status: 409 });
    }
    if (body.data.channel === "telegram" && !seeker.telegramChatId) {
      return NextResponse.json({ error: "telegram_not_linked" }, { status: 409 });
    }

    const target =
      body.data.channel === "email"
        ? normalizeEmail(seeker.email)
        : body.data.channel === "phone"
          ? normalizeMoroccanPhone(seeker.phone)
          : seeker.telegramChatId;
    if (!target) {
      return NextResponse.json({ error: "invalid_target" }, { status: 400 });
    }

    const meta = await requestMeta();
    const locale = (["ar", "fr", "en", "es"] as const).includes(seeker.locale as "ar")
      ? (seeker.locale as "ar")
      : "ar";
    const result = await issueAndSendOtp(body.data.channel, target, locale, meta.ip);
    void purgeExpiredOtps(); // مسح كسول للرموز المتقادمة

    if (!result.ok) {
      const status =
        result.code === "rate_limited" ? 429 : result.code === "provider_not_configured" ? 503 : 502;
      return NextResponse.json(
        { error: result.code, ...(result.retryAfterMs ? { retryAfterMs: result.retryAfterMs } : {}) },
        { status }
      );
    }
    return NextResponse.json({
      ok: true,
      // وضع التجربة الصريح فقط (OTP_DEV_SHOW_CODE=1) — لا يُعاد الرمز إلا بقرار المالك
      ...(result.devCode ? { devCode: result.devCode } : {}),
    });
  } catch (error) {
    console.error("[jobs/seeker/otp/send]", error);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}

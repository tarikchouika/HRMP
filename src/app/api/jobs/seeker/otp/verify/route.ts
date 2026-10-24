// HRMP — تحقق رمز OTP للباحث: يثبّت القناة (بريد/هاتف) ويمنع إعادة التحقق
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getSeekerSession } from "@/lib/recruitment/seeker-auth";
import { verifyOtp } from "@/lib/recruitment/otp";
import { markChannelVerified } from "@/lib/recruitment/service";
import { normalizeEmail, normalizeMoroccanPhone } from "@/lib/recruitment/types";

const schema = z.object({
  channel: z.enum(["email", "phone", "telegram"]),
  code: z.string().regex(/^\d{6}$/),
});

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

    const outcome = await verifyOtp(body.data.channel, target, body.data.code);
    if (outcome !== "ok") {
      const status =
        outcome === "too_many_attempts" || outcome === "expired" ? 410 : outcome === "not_found" ? 404 : 401;
      return NextResponse.json({ error: outcome }, { status });
    }
    const result = await markChannelVerified(session.sub, body.data.channel);
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("[jobs/seeker/otp/verify]", error);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}

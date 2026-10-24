// HRMP — توليد رابط ربط تيليغرام للباحث (توكن أحادي 15 دقيقة)
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getSeekerSession } from "@/lib/recruitment/seeker-auth";
import { rateLimit } from "@/lib/rate-limit";
import { createTelegramLinkToken, telegramBotDeepLink } from "@/lib/recruitment/telegram-link";

declare const process: { env: Record<string, string | undefined> };

export async function POST() {
  try {
    const session = await getSeekerSession();
    if (!session) {
      return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
    }
    if (!process.env.TELEGRAM_BOT_TOKEN) {
      return NextResponse.json({ error: "telegram_not_configured" }, { status: 503 });
    }

    const limit = rateLimit(`telegram-link:${session.sub}`, 5, 10 * 60 * 1000);
    if (!limit.allowed) {
      return NextResponse.json(
        { error: "rate_limited", retryAfterMs: limit.retryAfterMs },
        { status: 429 }
      );
    }

    const seeker = await db.jobSeeker.findUnique({
      where: { id: session.sub },
      select: { telegramChatId: true, telegramUsername: true, telegramVerifiedAt: true },
    });
    if (!seeker) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    if (seeker.telegramChatId) {
      return NextResponse.json({
        ok: true,
        linked: true,
        username: seeker.telegramUsername,
        verified: !!seeker.telegramVerifiedAt,
      });
    }

    const { token, hash, expiresAt } = createTelegramLinkToken();
    await db.jobSeeker.update({
      where: { id: session.sub },
      data: { telegramLinkTokenHash: hash, telegramLinkTokenExpiresAt: expiresAt },
    });

    return NextResponse.json({
      ok: true,
      linked: false,
      deepLink: telegramBotDeepLink(token),
      expiresAt: expiresAt.toISOString(),
    });
  } catch (error) {
    console.error("[jobs/seeker/telegram/link]", error);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}

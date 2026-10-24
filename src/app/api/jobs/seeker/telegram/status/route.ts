// HRMP — حالة ربط تيليغرام للباحث (تستعملها صفحة التسجيل للاستطلاع)
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getSeekerSession } from "@/lib/recruitment/seeker-auth";

export async function GET() {
  try {
    const session = await getSeekerSession();
    if (!session) {
      return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
    }
    const seeker = await db.jobSeeker.findUnique({
      where: { id: session.sub },
      select: {
        telegramChatId: true,
        telegramUsername: true,
        telegramLinkedAt: true,
        telegramVerifiedAt: true,
      },
    });
    if (!seeker) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    return NextResponse.json({
      linked: !!seeker.telegramChatId,
      username: seeker.telegramUsername,
      linkedAt: seeker.telegramLinkedAt?.toISOString() ?? null,
      verified: !!seeker.telegramVerifiedAt,
      verifiedAt: seeker.telegramVerifiedAt?.toISOString() ?? null,
    });
  } catch (error) {
    console.error("[jobs/seeker/telegram/status]", error);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}

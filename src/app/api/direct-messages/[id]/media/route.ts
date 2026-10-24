// HRMP — تسليم حمولة رسالة مرئية (صورة/فيديو): المرسل أو المستقبِل فقط
// (عزل مباشر — لا روابط عمومية).
// (بلاغ المالك 2026-10-25): الفيديو مؤقت — المُستهلك (مشاهدة المتلقّي أو
// المعني بالأمر) أو المنتهي العمر (TTL) تُرجع 410 Gone (الحمولة مُسحت؛
// السجل الوصفي وحده باقٍ للتدقيق) — نفس عقد الصوتيات.
// لا تخزين مؤقت للحمولة (private, no-store): المحتوى قابل للمسح بعد الاستهلاك
// وأي نسخة وسيطة (كانت immutable/max-age=86400) تخدم فيديو مُستهلكًا بعد مسحه.
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { AccessError } from "@/lib/rbac";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await getSession();
    if (!session) throw new AccessError(401, "unauthenticated");
    const { id } = await params;

    const msg = await db.directMessage.findFirst({
      where: { id, companyId: session.companyId },
      select: { id: true, senderId: true, recipientId: true, mime: true, media: true, kind: true, purgedAt: true },
    });
    if (!msg) return NextResponse.json({ error: "not_found" }, { status: 404 });
    if (msg.senderId !== session.sub && msg.recipientId !== session.sub) {
      throw new AccessError(403, "forbidden");
    }
    // فيديو مُستهلك/منتهي العمر: الحمولة مُسحت — 410 (بقاء السجل الوصفي للتدقيق)
    if (msg.purgedAt) {
      return NextResponse.json({ error: "media_purged" }, { status: 410 });
    }
    if (!msg.media) return NextResponse.json({ error: "no_media" }, { status: 404 });
    const body = new Uint8Array(msg.media);
    return new NextResponse(body, {
      status: 200,
      headers: {
        "Content-Type": msg.mime || "application/octet-stream",
        "Content-Length": String(body.byteLength),
        // الصور ثابتة (تُخزَّن خاصة 24 ساعة)؛ الفيديو قابل للمسح بعد الاستهلاك —
        // لا نسخ وسيطة له إطلاقًا (كانت immutable/max-age=86400 تخدم مستهلكًا بعد مسحه)
        "Cache-Control": msg.kind === "video" ? "private, no-store" : "private, max-age=86400",
        "Content-Disposition": `inline; filename="dm-${id}.${msg.kind === "photo" ? "jpg" : "webm"}"`,
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    if (error instanceof AccessError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error("[direct-messages/[id]/media GET]", error);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}

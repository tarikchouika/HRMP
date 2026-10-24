// HRMP — رسالة مرئية/موقعية مفردة: تعليم «شوهدت» من المستقبِل (مرة واحدة)
// — مقابل listenedAt في الصوتيات؛ استماع/مشاهدة الإشراف لا تعلّمها.
// (بلاغ المالك 2026-10-25): الفيديو مؤقت مثل الصوت — أول مشاهدة من المستقبِل
// تستهلكه فتُمسح حمولته فورًا (السجل الوصفي يبقى للتدقيق والبث بعدها 410)،
// والمعني بالأمر (إشراف voice.admin) يستهلكه بـ consumed دون تعليم viewedAt.
// الصور والمواقع خارج سياسة المسح — تعليم viewedAt فقط كما كان.
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { AccessError, roleHas } from "@/lib/rbac";
import { hasPermission } from "@/lib/delegations";
import { purgeDirectMessage } from "@/lib/direct-ephemeral";

const bodySchema = z.union([
  z.object({ viewed: z.literal(true) }),
  z.object({ consumed: z.literal(true) }),
]);

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await getSession();
    if (!session) throw new AccessError(401, "unauthenticated");
    const { id } = await params;

    const body = await req.json().catch(() => null);
    const parsed = bodySchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: "invalid_input" }, { status: 400 });
    }

    const msg = await db.directMessage.findFirst({
      where: { id, companyId: session.companyId },
      select: { id: true, recipientId: true, viewedAt: true, kind: true, purgedAt: true },
    });
    if (!msg) return NextResponse.json({ error: "not_found" }, { status: 404 });

    // 1) المشاهدة (المستقبِل فقط): أول مشاهدة تثبّت الوقت — والفيديو يُستهلك
    //    فتُمسح حمولته فورًا (إن لم تُمسح سابقًا)
    if ("viewed" in parsed.data && parsed.data.viewed === true) {
      if (msg.recipientId !== session.sub) {
        // المستقبِل وحده يعلّمها — استعراض الإشراف لا يعلّمها (نفس مبدأ الصوتيات)
        throw new AccessError(403, "forbidden");
      }
      if (!msg.viewedAt) {
        await db.directMessage.update({
          where: { id: msg.id },
          data: { viewedAt: new Date() },
        });
      }
      // المتلقي استهلك الفيديو ⇒ الحمولة تُمسح فورًا (الصور/المواقع لا)
      let purged = false;
      if (msg.kind === "video") {
        purged = await purgeDirectMessage(msg.id, session.sub);
      }
      return NextResponse.json({ ok: true, purged });
    }

    // 2) استهلاك المعني بالأمر (إشراف voice.admin) أو أحد طرفي الرسالة لمقطع
    //    فيديو: مسح الحمولة دون تعليم viewedAt — الطرفان يريان شارة «مُستهلك»
    if ("consumed" in parsed.data && parsed.data.consumed === true) {
      const admin = roleHas(session.role, "voice.admin") || (await hasPermission(session as never, "voice.admin"));
      const sender = await db.directMessage.findFirst({
        where: { id: msg.id, companyId: session.companyId, senderId: session.sub },
        select: { id: true },
      });
      const isParty = msg.recipientId === session.sub || !!sender;
      if (!admin && !isParty) {
        throw new AccessError(403, "forbidden");
      }
      const purged = msg.kind === "video" ? await purgeDirectMessage(msg.id, session.sub) : false;
      return NextResponse.json({ ok: true, purged });
    }

    return NextResponse.json({ error: "invalid_input" }, { status: 400 });
  } catch (error) {
    if (error instanceof AccessError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error("[direct-messages/[id] PATCH]", error);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}

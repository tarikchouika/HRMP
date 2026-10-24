// HRMP — اشتراكات دفع المتصفح (المرحلة 5 — SPEC §7: Web Push مفتوح، محوّل قابل للتبديل)
// GET: مفتاح VAPID العام (null = الدفع غير مفعّل) | POST: تسجيل اشتراك | DELETE: إلغاء
// (بلاغ المالك 2026-10-25 — صلاحية الإشعارات): تسجيل اشتراك الدفع يستلزم
// notifications.push (لكل الأدوار بطبعها — قابلة للتفويض والسحب من السوبر أدمن).
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { AccessError, roleHas } from "@/lib/rbac";
import { hasPermission } from "@/lib/delegations";
import { vapidPublicKey } from "@/lib/notifications";

const subscribeSchema = z.object({
  endpoint: z.string().url().max(2048),
  keys: z.object({
    p256dh: z.string().trim().min(1).max(256),
    auth: z.string().trim().min(1).max(256),
  }),
  userAgent: z.string().max(400).optional().or(z.literal("")),
});

export async function GET() {
  try {
    const session = await getSession();
    if (!session) throw new AccessError(401, "unauthenticated");
    // مفتاح VAPID العام للمتصفح — رؤيته حاجة العميل لقراءة حالة الدفع (self.view كافية)
    if (!roleHas(session.role, "self.view") && !(await hasPermission(session, "self.view"))) {
      throw new AccessError(403, "forbidden");
    }
    return NextResponse.json({ vapidPublicKey: vapidPublicKey() });
  } catch (error) {
    if (error instanceof AccessError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const session = await getSession();
    if (!session) throw new AccessError(401, "unauthenticated");
    // (بلاغ المالك 2026-10-25): صلاحية إشعارات الأجهزة — notifications.push
    // (لكل الأدوار بطبعها في rbac.ts — والسوبر أدمن قد يسحبها/يمنحها بالتفويض)
    const canPush =
      roleHas(session.role, "notifications.push") || (await hasPermission(session, "notifications.push"));
    if (!canPush) throw new AccessError(403, "notifications_forbidden");

    const parsed = subscribeSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: "invalid_input" }, { status: 400 });
    }

    // upsert على endpoint: نفس المتصفح يحدّث مفاتيحه لا يكرّر صفًا
    const device = await db.device.upsert({
      where: { endpoint: parsed.data.endpoint },
      update: {
        p256dh: parsed.data.keys.p256dh,
        auth: parsed.data.keys.auth,
        userAgent: parsed.data.userAgent || null,
        isActive: true, // إعادة تفعيل جهاز عاد من الإلغاء
      },
      create: {
        userId: session!.sub,
        endpoint: parsed.data.endpoint,
        p256dh: parsed.data.keys.p256dh,
        auth: parsed.data.keys.auth,
        userAgent: parsed.data.userAgent || null,
      },
    });
    return NextResponse.json({ deviceId: device.id }, { status: 201 });
  } catch (error) {
    if (error instanceof AccessError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error("[devices:subscribe]", error);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const session = await getSession();
    if (!session) throw new AccessError(401, "unauthenticated");

    const url = new URL(req.url);
    const endpoint = url.searchParams.get("endpoint")?.trim() ?? "";
    if (!endpoint) {
      return NextResponse.json({ error: "invalid_input" }, { status: 400 });
    }
    // تعطيل لا حذف (روح SPEC §11.7) — وملكية الجهاز للمستخدم نفسه؛ لا يكرّر تعطيل المعطَّل
    const result = await db.device.updateMany({
      where: { endpoint, userId: session!.sub, isActive: true },
      data: { isActive: false },
    });
    if (result.count === 0) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ deactivated: result.count });
  } catch (error) {
    if (error instanceof AccessError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error("[devices:unsubscribe]", error);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}

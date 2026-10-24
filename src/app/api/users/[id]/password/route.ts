// HRMP — تغيير كلمة سر مستخدم (بلاغ المالك 2026-10-25)
// ---------------------------------------------------------------------------
// «يجب إضافة صلاحية تغير كلمة سر المستخدمين للسوبر أدمين ويمكنه تفويضها للأدمن»:
//  - users.password — السوبر أدمن وحده بطبعه (rbac.ts) ويُفوَّض عبر delegations.ts.
//  - المفوَّض (أدمن) لا يغيّر كلمة سر سوبر أدمن — توازن حرّاس cannot_delete_super_admin:
//    تغيير كلمة مالك المنصة من موظف = استيلاء على الحساب (رفض قاطع 403).
//  - لا يغيّر كلمة سره عبر هذا المسار (تغيير الذات بكلمة المرور القديمة في
//    الملف الشخصي — هنا إداري بحت: 409).
//  - التغيير يُبطل كل جلسات المستخدم فورًا (sessionsInvalidatedAt) ويُسجَّل في
//    التدقيق (user_password_reset) بلا أي كلمة في السجل.
//  - كلمة السر الجديدة تُولَّد عشوائيًا إن لم تُرسل وتُعرض مرة واحدة في الاستجابة
//    حصرًا (نمط كلمة المرور الابتدائية — درس المرحلة 8: لا تخزين صريح أبدًا).
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { AccessError, roleHas } from "@/lib/rbac";
import { hasPermission } from "@/lib/delegations";
import { hashPassword } from "@/lib/auth/password";
import { writeAudit } from "@/lib/audit";

function randomPassword(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  let out = "";
  for (let i = 0; i < 12; i += 1) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return `Hr-${out}!`;
}

const resetSchema = z.object({
  password: z.string().min(8).max(72).optional(),
});

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await getSession();
    if (!session) throw new AccessError(401, "unauthenticated");

    // صلاحية تغيير الكلمات: السوبر بطبعه أو مفوَّض (users.password)
    const allowed = roleHas(session.role, "users.password") || (await hasPermission(session, "users.password"));
    if (!allowed) throw new AccessError(403, "forbidden");

    const { id } = await params;
    if (id === session.sub) {
      // تغيير كلمة الذات بكلمة قديمة في الملف الشخصي — هنا إداري للآخرين
      return NextResponse.json({ error: "cannot_reset_own_password" }, { status: 409 });
    }

    const membership = await db.userMembership.findFirst({
      where: { userId: id, companyId: session.companyId, revokedAt: null },
      select: { role: true, user: { select: { id: true, email: true, isActive: true } } },
    });
    if (!membership) return NextResponse.json({ error: "not_found" }, { status: 404 });

    // 🔒 مالك المنصة محمي من غير المالك: المفوَّض (أدمن) لا يغيّر كلمة سوبر أدمن —
    // وحده المالك (سوبر أدمن بطبعه) يغيّر كلمة نظرائه (توازن cannot_delete_super_admin)
    if (membership.role === "super_admin" && session.role !== "super_admin") {
      return NextResponse.json({ error: "cannot_reset_super_admin_password" }, { status: 403 });
    }

    const parsed = resetSchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) {
      return NextResponse.json({ error: "invalid_input" }, { status: 400 });
    }

    const newPassword = parsed.data.password ?? randomPassword();
    const passwordHash = await hashPassword(newPassword);

    // الكلمة الجديدة + إبطال كل جلساته فورًا (نمط sessionsInvalidatedAt)
    await db.user.update({
      where: { id: membership.user.id },
      data: { passwordHash, sessionsInvalidatedAt: new Date() },
    });

    await writeAudit({
      companyId: session.companyId,
      userId: session.sub,
      action: "user.password_reset",
      entity: "user",
      entityId: membership.user.id,
      after: { email: membership.user.email, generated: !parsed.data.password },
    });

    // كلمة السر الجديدة: تُعرض مرة واحدة هنا حصرًا — لا تُخزَّن صريحة
    return NextResponse.json({
      ok: true,
      user: { id: membership.user.id, email: membership.user.email },
      newPassword,
      passwordGenerated: !parsed.data.password,
    });
  } catch (error) {
    if (error instanceof AccessError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error("[users/:id/password POST]", error);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}

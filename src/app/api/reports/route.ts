// HRMP — التقارير: الأنواع المتاحة للدور + سجل التصديرات (SPEC §4.4.1 — المرحلة 7)
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { AccessError } from "@/lib/rbac";
import { reportKindsForRole, requireSession, listRecentDocuments, ReportDataError } from "@/lib/reports/generate";
import { KIND_FORMATS } from "@/lib/reports/types";
import { localizedName } from "@/lib/localized-name";
import { getUiLocale } from "@/i18n/ui-locale";

export async function GET() {
  try {
    const session = await requireSession();
    const settings = await db.companySettings.findUnique({ where: { companyId: session.companyId } });
    const canSeeWages = settings?.showWagesToSupervisor === true;
    const kinds = reportKindsForRole(session.role, canSeeWages).map((kind) => ({
      kind,
      formats: KIND_FORMATS[kind],
    }));
    const recent = await listRecentDocuments(session, 20);

    // علاج بلاغ المالك 2026-10-25 (توليد بيان الحضور/الساعات): كانت خيارات الهدف تُحمَّل
    // من /api/payroll/workers — وهي تتطلب صلاحية payroll.approve (لا يملكها المحاسب
    // ولا الكوأدمن) وتقتصر قائمتها على عضويات دور «عامل» — فتصير القائمة فارغة في
    // شركات بلا عمال، وتُخفي الواجهة المنتقي وتسمح بـ«self» فيرفض الخادم بـ404
    // worker_not_in_company. القائمة الصحيحة هنا: **كل أعضاء الشركة النشطين** (أي
    // عضو هدفٌ صالح خادميًا — generate.ts يفحص العضوية فقط لا الدور)، بلا أي بيانات
    // أجور حساسة — الاسم والدور فقط، وهما ظاهران أصلًا في صفحة مستخدمي الشركة.
    const locale = await getUiLocale();
    const memberships = await db.userMembership.findMany({
      where: { companyId: session.companyId, revokedAt: null, user: { isActive: true } },
      include: { user: { select: { id: true, fullName: true, names: true, email: true } } },
    });
    const members = memberships
      .map((m) => ({
        userId: m.user.id,
        fullName: localizedName(m.user, locale, "fullName"),
        email: m.user.email,
        role: m.role,
      }))
      .sort((a, b) => a.fullName.localeCompare(b.fullName, "ar"));

    return NextResponse.json({ kinds, recent, role: session.role, members });
  } catch (error) {
    if (error instanceof AccessError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof ReportDataError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error("[reports:GET]", error);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}

// HRMP — إدارة المستخدمين (المرحلة 9 — v0.10.0)
// ---------------------------------------------------------------------------
// قاعدة المالك 2026-10-18: «السوبر أدمين وحده له صلاحية تسجيل حسابات المستخدمين،
// وله جميع الصلاحيات، ويمكنه تفويض الصلاحيات».
// POST (إنشاء حساب): users.create — السوبر أدمن بطبعه، أو من فوَّضها إليه (تفويض قابل للسحب).
// PATCH (تعديل/تعطيل): users.manage كما في المصفوفة (بقاءً على المكتسبات).
// كلمة المرور الابتدائية: تُولَّد عشوائيًا إن لم تُرسل وتُعرض مرة واحدة في الاستجابة حصرًا
// (درس المرحلة 8: بيانات التسليم الأمنية تُعرض مرة واحدة ولا تُخزَّن صريحة أبدًا).
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { AccessError, roleHas, ROLES } from "@/lib/rbac";
import { hasPermission } from "@/lib/delegations";
import { hashPassword } from "@/lib/auth/password";
import { writeAudit } from "@/lib/audit";
import { isJobTitleKey } from "@/lib/job-titles";
import { getUiLocale } from "@/i18n/ui-locale";
import { localizedName, localeNamesSchema, namesColumnValue } from "@/lib/localized-name";

function randomInitialPassword(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  let out = "";
  for (let i = 0; i < 12; i += 1) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  // (إعادة التسمية 2026-10-24): البادئة Hr- بدل Fw- (بقية تغيير الاسم فاتتها الجولة)
  return `Hr-${out}!`;
}

export async function GET() {
  try {
    const session = await getSession();
    if (!session) throw new AccessError(401, "unauthenticated");

    // (تفتيش المالك 2026-10-19 «تفحص جميع وظائف المنصة وصلاحيات المستخدمين»):
    // كان GET يكشف كل مستخدمي الشركة (بريد/هاتف/دور/آخر دخول) لأي حساب مسجل الدخول
    // — بما فيه العامل الميداني. القاعدة 4: التحقق من الصلاحيات في الخادم دائمًا.
    // المستهلك الوحيد لهذا المسار صفحة «المستخدمون» (users.manage بطبعه أو بتفويض).
    if (!roleHas(session.role, "users.manage") && !(await hasPermission(session, "users.manage"))) {
      throw new AccessError(403, "forbidden");
    }
    const locale = await getUiLocale();

    const memberships = await db.userMembership.findMany({
      where: { companyId: session.companyId, revokedAt: null },
      include: {
        user: {
          select: {
            id: true,
            email: true,
            fullName: true,
            names: true,
            phone: true,
            isActive: true,
            lastLoginAt: true,
            employeeProfiles: {
              where: { companyId: session.companyId, status: "active" },
              select: { jobTitleKey: true, jobTitleCustom: true },
              take: 1,
            },
          },
        },
      },
      orderBy: { grantedAt: "asc" },
    });

    return NextResponse.json({
      count: memberships.length,
      users: memberships.map((m) => ({
        userId: m.user.id,
        email: m.user.email,
        // اسم العرض يتبع لغة الواجهة؛ الأساسي محفوظ في baseName لنماذج التعديل
        fullName: localizedName(m.user, locale, "fullName"),
        baseName: m.user.fullName,
        names: m.user.names,
        phone: m.user.phone,
        role: m.role,
        isActive: m.user.isActive,
        lastLoginAt: m.user.lastLoginAt ? m.user.lastLoginAt.toISOString() : null,
        jobTitleKey: m.user.employeeProfiles[0]?.jobTitleKey ?? null,
        jobTitleCustom: m.user.employeeProfiles[0]?.jobTitleCustom ?? null,
      })),
    });
  } catch (error) {
    if (error instanceof AccessError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error("[users GET]", error);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}

const createSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(190),
  fullName: z.string().trim().min(2).max(120),
  names: localeNamesSchema.optional(),
  phone: z.string().trim().max(32).optional().nullable(),
  password: z.string().min(8).max(72).optional(),
  role: z.enum(ROLES),
  jobTitleKey: z.string().max(64).nullable().optional(),
});

export async function POST(req: NextRequest) {
  try {
    const session = await getSession();
    if (!session) throw new AccessError(401, "unauthenticated");

    // إنشاء الحسابات: users.create — السوبر أدمن أو مفوَّض (قاعدة المالك)
    if (session.role !== "super_admin") {
      const delegated = await hasPermission(session, "users.create");
      if (!delegated) throw new AccessError(403, "forbidden");
    }

    const parsed = createSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: "invalid_input" }, { status: 400 });
    }

    // 🔒 فحص أمني 2026-10-21: التفويض users.create لا يشمل إنشاء مالك منصة
    // (مُثبت حيًّا: مدير مفوَّض أنشأ حساب super_admin ⇒ صلاحيات المالك كاملة داخل الشركة).
    // روح قاعدة المالك 2026-10-18: platform.manage «لا تُفوَّض» — وإنشاء حساب سوبر
    // أدمن يمنح عمليًا كل الصلاحيات دفعة واحدة، فالحدّ الأدنى المنطقي للتفويض:
    // كل الأدوار إلا super_admin (السوبر الحقيقي يبقى وحده من يُنشئ نظراءه).
    if (session.role !== "super_admin" && parsed.data.role === "super_admin") {
      return NextResponse.json({ error: "cannot_create_super_admin_delegated" }, { status: 403 });
    }
    if (parsed.data.jobTitleKey && !isJobTitleKey(parsed.data.jobTitleKey)) {
      return NextResponse.json({ error: "invalid_job_title" }, { status: 400 });
    }

    const data = parsed.data;
    const existing = await db.user.findUnique({ where: { email: data.email }, select: { id: true } });
    if (existing) {
      return NextResponse.json({ error: "email_taken" }, { status: 409 });
    }

    const initialPassword = data.password ?? randomInitialPassword();
    const passwordHash = await hashPassword(initialPassword);

    const result = await db.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          email: data.email,
          fullName: data.fullName,
          names: namesColumnValue(data.names),
          phone: data.phone ? data.phone : null,
          passwordHash,
          locale: session.locale || "ar",
        },
      });
      // العضوية في الشركة النشطة للمُنشئ (isDefault واحدة لكل مستخدم — درس المرحلة 8)
      const priorMemberships = await tx.userMembership.count({ where: { userId: user.id } });
      await tx.userMembership.create({
        data: {
          userId: user.id,
          companyId: session.companyId,
          role: data.role,
          isDefault: priorMemberships === 0,
        },
      });
      if (data.jobTitleKey) {
        await tx.employeeProfile.create({
          data: {
            companyId: session.companyId,
            userId: user.id,
            jobTitleKey: data.jobTitleKey,
          },
        });
      }
      return user;
    });

    await writeAudit({
      companyId: session.companyId,
      userId: session.sub,
      action: "user.create",
      entity: "user",
      entityId: result.id,
      after: { email: result.email, role: data.role, jobTitleKey: data.jobTitleKey ?? null },
    });

    // كلمة المرور الابتدائية: تُعرض مرة واحدة هنا حصرًا — لا تُخزَّن صريحة
    const generated = !data.password;
    return NextResponse.json({
      ok: true,
      user: { id: result.id, email: result.email, role: data.role },
      initialPassword: initialPassword,
      passwordGenerated: generated,
    });
  } catch (error) {
    if (error instanceof AccessError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error("[users POST]", error);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}

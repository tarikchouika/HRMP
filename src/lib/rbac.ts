// HRMP — التحكم بالوصول القائم على الأدوار (SPEC §3)
// الطبقة الوحيدة للتحقق من الصلاحيات في الخادم — قابلة للاختبار، لا تُكرَّر في الواجهات
import type { SessionPayload } from "@/lib/auth/jwt";

export const ROLES = ["super_admin", "accountant", "admin", "co_admin", "employee"] as const;
export type Role = (typeof ROLES)[number];

export function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value);
}

/** الصلاحيات المنطقية للمنصة — تُوسَّع مع المراحل التالية
 *  المرحلة 9 (v0.10.0): users.create (تسجيل الحسابات — للسوبر أدمن حصرًا بطبعه، ويُفوَّض)،
 *  teams.manage (إدارة الفرق: أعضاء/قائد/احتياط)، voice.use/voice.admin (الرسائل الصوتية)،
 *  location.view (المواقع الأنية). التفويض فوق الدور عبر delegations.ts (السوبر أدمن وحده). */
export const PERMISSIONS = [
  "platform.manage", // إدارة الشركات والمالك وإعدادات النظام — لا تُفوَّض (روح الملكية)
  "company.manage", // إدارة فروع/مواقع/مشاريع الشركة
  "users.manage", // إدارة مستخدمي الشركة (تعديل/تعطيل) — إنشاء الحسابات users.create
  "users.create", // تسجيل حسابات المستخدمين — السوبر أدمن وحده بطبعه (قاعدة المالك 2026-10-18) ويُفوَّض
  "users.password", // (بلاغ المالك 2026-10-25) تغيير كلمة سر المستخدمين — السوبر أدمن وحده بطبعه ويُفوَّض للأدمن؛ المفوَّض لا يغيّر كلمة سر سوبر أدمن
  "data.delete", // الحذف النهائي (مستخدم/شركة/مشروع/موقع/فرع) — السوبر أدمن وحده بطبعه (أمر المالك 2026-10-23 «لا أستطيع مسح أو إزالة…») ويُفوَّض
  "teams.manage", // إدارة الفرق: إضافة/إزالة أعضاء، تعيين قائد، تحديد فرق الإحتياط
  "voice.use", // الرسائل الصوتية داخل فريقه (لكل مستخدم) — العزل بين الفرق في الخادم
  "voice.admin", // الرسائل الصوتية عبر جميع الفرق والمستخدمين (سوبر/أدمن/كوأدمن)
  "location.view", // الاطلاع على الموقع الأني للأعضاء (سوبر/أدمن/كوأدمن — قادة الفرق ضمن فريقهم بالخدمة)
  "payroll.view", // عرض كشوف الأجور
  "payroll.approve", // اعتماد كشوف الأجور النهائية
  "payroll.verify", // توثيق قواعد الأجور (المحاسب — المرحلة 6أ/6ب: يمنع الاعتماد قبلها)
  "declarations.review", // مراجعة/اعتماد ملفات التصريح (CNSS/DGI)
  "declarations.export", // تصدير الملفات الرسمية
  "audit.view", // عرض سجل التدقيق
  "attendance.manage", // مراجعة الحضور وتعديلات الطوارئ
  "scheduling.manage", // تعيين البرامج اليومية
  "recruitment.manage", // إدارة الوظائف الشاغرة في مشاريع الشركة وطلبات التقديم (طلب المالك 2026-10-24)
  "seekers.verify", // مصادقة هوية الباحثين عن عمل (أمر المالك الصريح: الأدمن أو السوبر أدمن)
  "notifications.push", // (بلاغ المالك 2026-10-25) إشعارات الأجهزة (هواتف/حواسب/أندرويد): تسجيل اشتراكات الدفع واستقبالها — لكل الأدوار بطبعها ويُفوَّض
  "self.view", // بيانات المستخدم نفسه فقط
] as const;
export type Permission = (typeof PERMISSIONS)[number];

/** مصفوفة الأدوار ← الصلاحيات (SPEC §3)
 *  المرحلة 9: voice.use للجميع، وvoice.admin/location.view/teams.manage للإدارة؛
 *  users.create للسوبر أدمن حصرًا (يُفوَّض عبر delegations.ts عند الحاجة). */
const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  super_admin: [...PERMISSIONS],
  accountant: [
    "payroll.view",
    "payroll.verify",
    "declarations.review",
    "declarations.export",
    "audit.view",
    "voice.use",
    "notifications.push",
    "self.view",
  ],
  admin: [
    "company.manage",
    "users.manage",
    "teams.manage",
    "voice.use",
    "voice.admin",
    "location.view",
    "payroll.view",
    "payroll.approve",
    "audit.view",
    "attendance.manage",
    "scheduling.manage",
    "recruitment.manage",
    "seekers.verify",
    "notifications.push",
    "self.view",
  ],
  co_admin: ["attendance.manage", "scheduling.manage", "voice.use", "voice.admin", "location.view", "notifications.push", "self.view"],
  employee: ["self.view", "voice.use", "notifications.push"],
};

export function roleHas(role: string, permission: Permission): boolean {
  if (!isRole(role)) return false;
  return ROLE_PERMISSIONS[role].includes(permission);
}

export function sessionCan(session: SessionPayload | null, permission: Permission): boolean {
  if (!session) return false;
  return roleHas(session.role, permission);
}

/** حرّاس الوصول للمسارات الخادمية — ترمي استثناء يُحوَّل إلى 401/403 في الـ API */
export class AccessError extends Error {
  status: number;
  constructor(status: 401 | 403, message: string) {
    super(message);
    this.status = status;
  }
}

export function requirePermission(
  session: SessionPayload | null,
  permission: Permission
): SessionPayload {
  if (!session) throw new AccessError(401, "unauthenticated");
  if (!sessionCan(session, permission)) throw new AccessError(403, "forbidden");
  return session;
}

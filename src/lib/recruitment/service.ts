// HRMP — خدمة الاستقطاب والتوظيف (طلب المالك 2026-10-24): كل منطق العمل في الخادم
// ---------------------------------------------------------------------------
// العزل النافذ: كل مسار شركة يمرّ بجلسة الموظف (companyId من الجلسة لا العميل) —
// وكل مسار باحث بجلسة الباحث. الحساب العام يُفعَّل بمصادقة الأدمن/السوبر أدمن
// (الأمر الصريح للمالك) بعد تحقق آلي مزدوج (بريد + هاتف) ورفع وثيقة الهوية.
// التدقيق يكتب لكل فعل حساس (writeAudit — لا يُفشل العمل الأصلي أبدًا).
import { createHash } from "node:crypto";
import { db } from "@/lib/db";
import { writeAudit } from "@/lib/audit";
import { localizedName } from "@/lib/localized-name";
import { hashPassword, verifyPassword } from "@/lib/auth/password";
import { rateLimit } from "@/lib/rate-limit";
import { notifySeekerReady } from "@/lib/telegram";
import type { Locale } from "@/i18n/config";
import type { SessionPayload } from "@/lib/auth/jwt";
import {
  COVER_NOTE_MAX,
  DOC_ACCEPTED_MIMES,
  DOC_MAX_BYTES,
  OPENINGS_MAX,
  OPENINGS_MIN,
  SALARY_MAX_CENTIMES,
  SALARY_MIN_CENTIMES,
  VACANCY_DESC_MAX,
  VACANCY_TITLE_MAX,
  isAcceptablePassword,
  isDocumentType,
  isEmploymentType,
  isInternalSeedEmail,
  normalizeEmail,
  normalizeMoroccanPhone,
  type ApplicationStatus,
  type DocumentType,
  type EmploymentType,
} from "./types";

// ─── الأخطاء الموحّدة (ترجمات i18n: jobs.errors.*) ─────────────────────────────

export const SEEKER_ERRORS = [
  "email_taken",
  "phone_taken",
  "internal_email",
  "invalid_email",
  "invalid_phone",
  "weak_password",
  "invalid_name",
  "not_found",
  "not_active",
  "bad_credentials",
  "rate_limited",
  "email_unverified",
  "phone_unverified",
  "document_missing",
  "not_approved",
  "doc_too_large",
  "doc_bad_mime",
  "doc_bad_type",
  "already_applied",
  "vacancy_closed",
  "vacancy_not_found",
  "project_not_found",
  "forbidden",
  "invalid_input",
  "reason_required",
  "bad_transition",
  "provider_not_configured",
] as const;
export type SeekerError = (typeof SEEKER_ERRORS)[number];

export type Result<T> = { ok: true; data: T } | { ok: false; error: SeekerError };

function ok<T>(data: T): Result<T> {
  return { ok: true, data };
}
function err(error: SeekerError): Result<never> {
  return { ok: false, error };
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const NAME_RE = /^[\p{L}\p{M}][\p{L}\p{M}\s'’\-]{2,80}$/u;

// ─── تسجيل الباحث وتحققه ──────────────────────────────────────────────────────

export type RegisterInput = {
  fullName: string;
  email: string;
  phone: string;
  password: string;
  locale: string;
};

/** إنشاء حساب باحث: تحقق آلي (OTP لاحقًا لكل قناة) + وثيقة لاحقًا + مصادقة أدمن */
export async function registerSeeker(
  input: RegisterInput,
  meta: { ip: string | null; userAgent: string | null }
): Promise<Result<{ id: string }>> {
  // حدّ لكل IP لا للعالم أجمع (مفتاح ثابت = عدّاد عالمي يخنق كل التسجيلات) —
  // 10/ساعة: يحتمل محاولات خاطئة مشروعة قبل الإغلاق، ويبقى حادًا ضد الاستغلال
  const ipKey = `seeker-register-ip:${meta.ip ?? "unknown"}`;
  const allowed = rateLimit(ipKey, 10, 60 * 60 * 1000);
  if (!allowed.allowed) return err("rate_limited");

  const email = normalizeEmail(input.email ?? "");
  const phone = normalizeMoroccanPhone(input.phone ?? "");
  const fullName = (input.fullName ?? "").trim();

  if (!EMAIL_RE.test(email)) return err("invalid_email");
  if (isInternalSeedEmail(email)) return err("internal_email");
  if (!phone) return err("invalid_phone");
  if (!NAME_RE.test(fullName)) return err("invalid_name");
  if (!isAcceptablePassword(input.password ?? "")) return err("weak_password");

  const [emailClash, phoneClash] = await Promise.all([
    db.jobSeeker.findUnique({ where: { email }, select: { id: true } }),
    db.jobSeeker.findUnique({ where: { phone }, select: { id: true } }),
  ]);
  if (emailClash) return err("email_taken");
  if (phoneClash) return err("phone_taken");

  const locale: Locale = (["ar", "fr", "en", "es"] as const).includes(input.locale as Locale)
    ? (input.locale as Locale)
    : "ar";
  const passwordHash = await hashPassword(input.password);

  const seeker = await db.jobSeeker.create({
    data: { email, phone, fullName, passwordHash, locale, status: "pending" },
  });

  await writeAudit({
    action: "recruitment.seeker.register",
    entity: "JobSeeker",
    entityId: seeker.id,
    after: { email, phone: `+${phone}`, fullName },
  });
  return ok({ id: seeker.id });
}

/** تحقق OTP لقناة الباحث — يثبّت emailVerifiedAt/phoneVerifiedAt/telegramVerifiedAt */
export async function markChannelVerified(
  seekerId: string,
  channel: "email" | "phone" | "telegram"
): Promise<Result<true>> {
  const seeker = await db.jobSeeker.findUnique({ where: { id: seekerId }, select: { id: true } });
  if (!seeker) return err("not_found");
  await db.jobSeeker.update({
    where: { id: seekerId },
    data:
      channel === "email"
        ? { emailVerifiedAt: new Date() }
        : channel === "phone"
          ? { phoneVerifiedAt: new Date() }
          : { telegramVerifiedAt: new Date() },
  });
  await writeAudit({ action: "recruitment.seeker.verified", entity: "JobSeeker", entityId: seekerId, after: { channel } });
  // إشعار المشرف إن اكتمل التوثيق المزدوج + الوثيقة بهذه الخطوة (خلفية بلا حجب)
  void notifySeekerReady(seekerId);
  return ok(true);
}

/** رفع وثيقة الهوية (الصورة البايتية تحسب عند المنبع — الحجم والمِيم يُفحصان هنا) */
export async function uploadSeekerDocument(
  seekerId: string,
  doc: { type: string; fileName: string; mime: string; bytes: Buffer }
): Promise<Result<true>> {
  if (!isDocumentType(doc.type)) return err("doc_bad_type");
  if (!(DOC_ACCEPTED_MIMES as readonly string[]).includes(doc.mime)) return err("doc_bad_mime");
  if (doc.bytes.byteLength === 0 || doc.bytes.byteLength > DOC_MAX_BYTES) return err("doc_too_large");

  const documentHash = createHash("sha256").update(doc.bytes).digest("hex");
  await db.jobSeeker.update({
    where: { id: seekerId },
    data: {
      documentType: doc.type as DocumentType,
      documentName: doc.fileName.slice(0, 180),
      documentMime: doc.mime,
      documentBytes: new Uint8Array(doc.bytes),
      documentHash,
      status: "pending", // رفع/تبديل الوثيقة يعيد الحساب لقائمة المصادقة
      rejectionReason: null,
      reviewedById: null,
      reviewedAt: null,
    },
  });
  await writeAudit({
    action: "recruitment.document.uploaded",
    entity: "JobSeeker",
    entityId: seekerId,
    after: { type: doc.type, mime: doc.mime, bytes: doc.bytes.byteLength, sha256: documentHash.slice(0, 16) },
  });
  // إن كانت خطوة الوثيقة هي آخر شرط، يصل المشرف إشعار تيليغرام فورًا
  void notifySeekerReady(seekerId);
  return ok(true);
}

/** دخول الباحث — حدّ 10 محاولات/15د لكل بريد (نفس نمط دخول المنصة) */
export async function seekerLogin(
  email: string,
  password: string
): Promise<Result<{ id: string; email: string; fullName: string }>> {
  const normalized = normalizeEmail(email ?? "");
  const limited = rateLimit(`seeker-login:${normalized}`, 10, 15 * 60 * 1000);
  if (!limited.allowed) return err("rate_limited");

  const seeker = await db.jobSeeker.findUnique({ where: { email: normalized } });
  if (!seeker || !(await verifyPassword(password ?? "", seeker.passwordHash))) {
    return err("bad_credentials");
  }
  if (!seeker.isActive) return err("not_active");

  await db.jobSeeker.update({ where: { id: seeker.id }, data: { lastLoginAt: new Date() } });
  return ok({ id: seeker.id, email: seeker.email, fullName: seeker.fullName });
}

// ─── الوظائف للعموم (بيانات عامة معرَّضة بعناية — لا أي معلومات داخلية) ────────

export type PublicVacancy = {
  id: string;
  title: string;
  description: string;
  requirements: string | null;
  employmentType: string;
  salaryMin: number | null;
  salaryMax: number | null;
  openings: number;
  contactEmail: string | null;
  contactPhone: string | null;
  publishedAt: string;
  closesAt: string | null;
  companyName: string;
  projectName: string;
  branchCity: string | null;
};

function toPublicVacancy(
  row: { id: string; title: string; description: string; requirements: string | null; employmentType: string; salaryMin: number | null; salaryMax: number | null; openings: number; contactEmail: string | null; contactPhone: string | null; publishedAt: Date | null; closesAt: Date | null; company: { legalName: string; names: string | null }; project: { name: string; names: string | null; branch: { city: string | null } | null } },
  locale: Locale
): PublicVacancy {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    requirements: row.requirements,
    employmentType: row.employmentType,
    salaryMin: row.salaryMin,
    salaryMax: row.salaryMax,
    openings: row.openings,
    contactEmail: row.contactEmail,
    contactPhone: row.contactPhone ? `+${row.contactPhone}` : null,
    publishedAt: row.publishedAt!.toISOString(),
    closesAt: row.closesAt ? row.closesAt.toISOString() : null,
    companyName: localizedName(row.company, locale, "legalName"),
    projectName: localizedName(row.project, locale, "name"),
    branchCity: row.project.branch?.city ?? null,
  };
}

/** الوظيفة «مفتوحة فعليًا»: منشورة + لم تبلغ أجل الإغلاق */
function isOpenNow(v: { status: string; closesAt: Date | null }): boolean {
  return v.status === "published" && (!v.closesAt || v.closesAt.getTime() > Date.now());
}

export async function listPublicVacancies(
  locale: Locale,
  opts: { q?: string; page?: number }
): Promise<{ items: PublicVacancy[]; total: number; page: number; pages: number }> {
  const q = (opts.q ?? "").trim().toLowerCase();
  const page = Math.max(1, Math.floor(opts.page ?? 1));
  const pageSize = 12;

  // بحث بسيط محكم (SQLite LIKE على العنوان/الوصف/اسم الشركة/المشروع) — لا حقن:
  // عبر معامل آمن contains، والأسماء المحلية تُطبَّق بعد الجلب للعدالة بين اللغات
  const rows = await db.projectVacancy.findMany({
    where: { status: "published" },
    include: {
      company: { select: { legalName: true, names: true } },
      project: { select: { name: true, names: true, branch: { select: { city: true } } } },
    },
    orderBy: { publishedAt: "desc" },
    take: 500,
  });
  const open = rows.filter(isOpenNow);
  const filtered = q
    ? open.filter(
        (r) =>
          r.title.toLowerCase().includes(q) ||
          r.description.toLowerCase().includes(q) ||
          r.company.legalName.toLowerCase().includes(q) ||
          r.project.name.toLowerCase().includes(q)
      )
    : open;
  const total = filtered.length;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const items = filtered
    .slice((page - 1) * pageSize, page * pageSize)
    .map((r) => toPublicVacancy(r, locale));
  return { items, total, page, pages };
}

export async function getPublicVacancy(id: string, locale: Locale): Promise<PublicVacancy | null> {
  const row = await db.projectVacancy.findUnique({
    where: { id },
    include: {
      company: { select: { legalName: true, names: true } },
      project: { select: { name: true, names: true, branch: { select: { city: true } } } },
    },
  });
  if (!row || !isOpenNow(row)) return null;
  return toPublicVacancy(row, locale);
}

// ─── التقديم (بوابة الباحث) ───────────────────────────────────────────────────

export async function applyToVacancy(
  seekerId: string,
  vacancyId: string,
  coverNote?: string
): Promise<Result<{ id: string }>> {
  const seeker = await db.jobSeeker.findUnique({
    where: { id: seekerId },
    select: {
      isActive: true,
      status: true,
      emailVerifiedAt: true,
      phoneVerifiedAt: true,
      telegramVerifiedAt: true,
      documentType: true,
    },
  });
  if (!seeker || !seeker.isActive) return err("not_found");
  if (!seeker.emailVerifiedAt) return err("email_unverified");
  // العامل الثاني: هاتف موثّق بـSMS أو محادثة تيليغرام موثّقة بـOTP (بديل معتمد)
  if (!seeker.phoneVerifiedAt && !seeker.telegramVerifiedAt) return err("phone_unverified");
  if (!seeker.documentType) return err("document_missing");
  if (seeker.status !== "approved") return err("not_approved");

  const vacancy = await db.projectVacancy.findUnique({
    where: { id: vacancyId },
    select: { id: true, status: true, closesAt: true, companyId: true, title: true },
  });
  if (!vacancy) return err("vacancy_not_found");
  if (!isOpenNow(vacancy)) return err("vacancy_closed");

  if (coverNote && coverNote.length > COVER_NOTE_MAX) return err("invalid_input");

  const existing = await db.vacancyApplication.findUnique({
    where: { vacancyId_seekerId: { vacancyId, seekerId } },
    select: { id: true },
  });
  if (existing) return err("already_applied");

  const application = await db.vacancyApplication.create({
    data: { vacancyId, seekerId, coverNote: coverNote?.trim() || null, status: "submitted" },
  });
  await writeAudit({
    companyId: vacancy.companyId,
    action: "recruitment.application.created",
    entity: "VacancyApplication",
    entityId: application.id,
    after: { vacancyId, vacancyTitle: vacancy.title, seekerId },
  });
  return ok({ id: application.id });
}

/** طلبات الباحث (بوابة /jobs/me) — مع عناوين الوظائف واسم الشركة للعرض */
export async function listMyApplications(seekerId: string, locale: Locale) {
  const rows = await db.vacancyApplication.findMany({
    where: { seekerId },
    include: {
      vacancy: {
        select: {
          id: true,
          title: true,
          status: true,
          closesAt: true,
          company: { select: { legalName: true, names: true } },
        },
      },
    },
    orderBy: { createdAt: "desc" },
    take: 200,
  });
  return rows.map((r) => ({
    id: r.id,
    status: r.status,
    createdAt: r.createdAt.toISOString(),
    coverNote: r.coverNote,
    vacancy: {
      id: r.vacancy.id,
      title: r.vacancy.title,
      company: localizedName(r.vacancy.company, locale, "legalName"),
      closed: !isOpenNow(r.vacancy),
    },
  }));
}

/** سحب طلب تقديم (باحثه وحده) */
export async function withdrawApplication(seekerId: string, applicationId: string): Promise<Result<true>> {
  const row = await db.vacancyApplication.findUnique({
    where: { id: applicationId },
    select: { id: true, seekerId: true, status: true, vacancyId: true },
  });
  if (!row || row.seekerId !== seekerId) return err("not_found");
  if (row.status === "hired") return err("bad_transition");
  await db.vacancyApplication.update({
    where: { id: applicationId },
    data: { status: "withdrawn" },
  });
  return ok(true);
}

// ─── إدارة الشركة للوظائف (companyId من الجلسة حصرًا) ─────────────────────────

export type VacancyInput = {
  projectId: string;
  title: string;
  description: string;
  requirements?: string | null;
  employmentType: string;
  salaryMin?: number | null;
  salaryMax?: number | null;
  openings: number;
  contactEmail?: string | null;
  contactPhone?: string | null;
  closesAt?: Date | null;
};

function validateVacancyInput(input: VacancyInput): SeekerError | null {
  const title = (input.title ?? "").trim();
  const description = (input.description ?? "").trim();
  if (title.length < 3 || title.length > VACANCY_TITLE_MAX) return "invalid_input";
  if (description.length < 20 || description.length > VACANCY_DESC_MAX) return "invalid_input";
  if (!isEmploymentType(input.employmentType)) return "invalid_input";
  if (input.openings < OPENINGS_MIN || input.openings > OPENINGS_MAX) return "invalid_input";
  for (const s of [input.salaryMin, input.salaryMax]) {
    if (s != null && (s < SALARY_MIN_CENTIMES || s > SALARY_MAX_CENTIMES)) return "invalid_input";
  }
  if (input.salaryMin != null && input.salaryMax != null && input.salaryMin > input.salaryMax) return "invalid_input";
  if (input.contactEmail && !EMAIL_RE.test(input.contactEmail)) return "invalid_input";
  if (input.contactPhone) {
    const normalized = normalizeMoroccanPhone(input.contactPhone);
    if (!normalized) return "invalid_phone";
  }
  if (input.closesAt && input.closesAt.getTime() < Date.now()) return "invalid_input";
  return null;
}

async function projectInCompany(companyId: string, projectId: string): Promise<boolean> {
  const project = await db.project.findFirst({
    where: { id: projectId, companyId, status: "active" },
    select: { id: true },
  });
  return !!project;
}

export async function createVacancy(session: SessionPayload, input: VacancyInput): Promise<Result<{ id: string }>> {
  const invalid = validateVacancyInput(input);
  if (invalid) return err(invalid);
  if (!(await projectInCompany(session.companyId, input.projectId))) return err("project_not_found");

  const contactPhone = input.contactPhone ? normalizeMoroccanPhone(input.contactPhone) : null;
  const vacancy = await db.projectVacancy.create({
    data: {
      companyId: session.companyId,
      projectId: input.projectId,
      title: input.title.trim(),
      description: input.description.trim(),
      requirements: input.requirements?.trim() || null,
      employmentType: input.employmentType as EmploymentType,
      salaryMin: input.salaryMin ?? null,
      salaryMax: input.salaryMax ?? null,
      openings: input.openings,
      contactEmail: input.contactEmail?.trim().toLowerCase() || null,
      contactPhone,
      closesAt: input.closesAt ?? null,
      status: "draft",
    },
  });
  await writeAudit({
    companyId: session.companyId,
    userId: session.sub,
    action: "recruitment.vacancy.created",
    entity: "ProjectVacancy",
    entityId: vacancy.id,
    after: { projectId: input.projectId, title: vacancy.title },
  });
  return ok({ id: vacancy.id });
}

export async function updateVacancy(
  session: SessionPayload,
  vacancyId: string,
  input: VacancyInput
): Promise<Result<true>> {
  const invalid = validateVacancyInput(input);
  if (invalid) return err(invalid);
  const existing = await db.projectVacancy.findFirst({
    where: { id: vacancyId, companyId: session.companyId },
    select: { id: true },
  });
  if (!existing) return err("vacancy_not_found");
  if (!(await projectInCompany(session.companyId, input.projectId))) return err("project_not_found");

  const contactPhone = input.contactPhone ? normalizeMoroccanPhone(input.contactPhone) : null;
  await db.projectVacancy.update({
    where: { id: vacancyId },
    data: {
      projectId: input.projectId,
      title: input.title.trim(),
      description: input.description.trim(),
      requirements: input.requirements?.trim() || null,
      employmentType: input.employmentType as EmploymentType,
      salaryMin: input.salaryMin ?? null,
      salaryMax: input.salaryMax ?? null,
      openings: input.openings,
      contactEmail: input.contactEmail?.trim().toLowerCase() || null,
      contactPhone,
      closesAt: input.closesAt ?? null,
    },
  });
  await writeAudit({
    companyId: session.companyId,
    userId: session.sub,
    action: "recruitment.vacancy.updated",
    entity: "ProjectVacancy",
    entityId: vacancyId,
    after: { projectId: input.projectId, title: input.title.trim() },
  });
  return ok(true);
}

export async function setVacancyStatus(
  session: SessionPayload,
  vacancyId: string,
  status: "published" | "closed" | "draft"
): Promise<Result<true>> {
  const existing = await db.projectVacancy.findFirst({
    where: { id: vacancyId, companyId: session.companyId },
    select: { id: true, status: true, title: true },
  });
  if (!existing) return err("vacancy_not_found");
  if (existing.status === status) return ok(true);

  await db.projectVacancy.update({
    where: { id: vacancyId },
    data: { status, publishedAt: status === "published" ? new Date() : undefined },
  });
  await writeAudit({
    companyId: session.companyId,
    userId: session.sub,
    action: `recruitment.vacancy.${status === "published" ? "published" : status === "closed" ? "closed" : "reverted_to_draft"}`,
    entity: "ProjectVacancy",
    entityId: vacancyId,
    before: { status: existing.status },
    after: { status },
  });
  return ok(true);
}

export async function listCompanyVacancies(companyId: string, locale: Locale) {
  const rows = await db.projectVacancy.findMany({
    where: { companyId },
    include: {
      project: { select: { id: true, name: true, names: true } },
      _count: { select: { applications: true } },
    },
    orderBy: { createdAt: "desc" },
  });
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    description: r.description,
    requirements: r.requirements,
    employmentType: r.employmentType,
    salaryMin: r.salaryMin,
    salaryMax: r.salaryMax,
    openings: r.openings,
    contactEmail: r.contactEmail,
    contactPhone: r.contactPhone,
    status: r.status,
    publishedAt: r.publishedAt?.toISOString() ?? null,
    closesAt: r.closesAt?.toISOString() ?? null,
    project: { id: r.project.id, name: localizedName(r.project, locale, "name") },
    applicationsCount: r._count.applications,
    effectivelyOpen: isOpenNow(r),
  }));
}

export async function listVacancyApplications(session: SessionPayload, vacancyId: string) {
  const vacancy = await db.projectVacancy.findFirst({
    where: { id: vacancyId, companyId: session.companyId },
    select: { id: true, title: true, status: true },
  });
  if (!vacancy) return err("vacancy_not_found");

  const rows = await db.vacancyApplication.findMany({
    where: { vacancyId },
    include: {
      seeker: {
        select: {
          id: true,
          fullName: true,
          email: true,
          phone: true,
          status: true,
          documentType: true,
          emailVerifiedAt: true,
          phoneVerifiedAt: true,
          telegramVerifiedAt: true,
        },
      },
    },
    orderBy: { createdAt: "desc" },
  });
  return ok({
    vacancy: { id: vacancy.id, title: vacancy.title, status: vacancy.status },
    items: rows.map((r) => ({
      id: r.id,
      status: r.status,
      createdAt: r.createdAt.toISOString(),
      coverNote: r.coverNote,
      seeker: {
        id: r.seeker.id,
        fullName: r.seeker.fullName,
        email: r.seeker.email,
        phone: `+${r.seeker.phone}`,
        accountStatus: r.seeker.status,
        documentType: r.seeker.documentType,
        emailVerified: !!r.seeker.emailVerifiedAt,
        phoneVerified: !!r.seeker.phoneVerifiedAt,
        telegramVerified: !!r.seeker.telegramVerifiedAt,
      },
    })),
  });
}

const ALLOWED_TRANSITIONS: Record<string, ApplicationStatus[]> = {
  submitted: ["viewed", "shortlisted", "rejected", "hired"],
  viewed: ["shortlisted", "rejected", "hired"],
  shortlisted: ["hired", "rejected"],
  rejected: [],
  hired: [],
  withdrawn: [],
};

export async function setApplicationStatus(
  session: SessionPayload,
  applicationId: string,
  status: string
): Promise<Result<true>> {
  const row = await db.vacancyApplication.findFirst({
    where: { id: applicationId, vacancy: { companyId: session.companyId } },
    select: { id: true, status: true, seekerId: true, vacancyId: true },
  });
  if (!row) return err("not_found");
  if (!(ALLOWED_TRANSITIONS[row.status] ?? []).includes(status as ApplicationStatus)) {
    return err("bad_transition");
  }
  await db.vacancyApplication.update({ where: { id: applicationId }, data: { status } });
  await writeAudit({
    companyId: session.companyId,
    userId: session.sub,
    action: "recruitment.application.status",
    entity: "VacancyApplication",
    entityId: applicationId,
    before: { status: row.status },
    after: { status, seekerId: row.seekerId, vacancyId: row.vacancyId },
  });
  return ok(true);
}

// ─── مصادقة الباحثين (الأدمن/السوبر أدمن — طلب المالك الصريح) ────────────────

export async function listSeekersForReview(opts: { status?: string; q?: string; page?: number }) {
  const status = opts.status && ["pending", "approved", "rejected"].includes(opts.status) ? opts.status : undefined;
  const q = (opts.q ?? "").trim().toLowerCase();
  const page = Math.max(1, Math.floor(opts.page ?? 1));
  const pageSize = 15;

  const rows = await db.jobSeeker.findMany({
    where: status ? { status } : undefined,
    orderBy: [{ status: "asc" }, { createdAt: "desc" }], // pending أولاً (أبجديًا)
    take: 600,
    select: {
      id: true,
      fullName: true,
      email: true,
      phone: true,
      status: true,
      emailVerifiedAt: true,
      phoneVerifiedAt: true,
      telegramVerifiedAt: true,
      telegramUsername: true,
      documentType: true,
      documentName: true,
      rejectionReason: true,
      reviewedAt: true,
      createdAt: true,
      applications: { select: { id: true }, take: 1 },
    },
  });
  const filtered = q
    ? rows.filter((r) => r.fullName.toLowerCase().includes(q) || r.email.toLowerCase().includes(q))
    : rows;
  const total = filtered.length;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const items = filtered.slice((page - 1) * pageSize, page * pageSize).map((r) => ({
    id: r.id,
    fullName: r.fullName,
    email: r.email,
    phone: `+${r.phone}`,
    status: r.status,
    emailVerified: !!r.emailVerifiedAt,
    phoneVerified: !!r.phoneVerifiedAt,
    telegramVerified: !!r.telegramVerifiedAt,
    telegramUsername: r.telegramUsername,
    hasDocument: !!r.documentType,
    documentType: r.documentType,
    documentName: r.documentName,
    rejectionReason: r.rejectionReason,
    reviewedAt: r.reviewedAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
    hasApplications: r.applications.length > 0,
  }));
  return { items, total, page, pages };
}

export async function getSeekerDocumentForReview(seekerId: string): Promise<{ mime: string; bytes: Buffer; name: string } | null> {
  const seeker = await db.jobSeeker.findUnique({
    where: { id: seekerId },
    select: { documentMime: true, documentBytes: true, documentName: true, documentType: true },
  });
  if (!seeker || !seeker.documentBytes || !seeker.documentMime) return null;
  return { mime: seeker.documentMime, bytes: Buffer.from(seeker.documentBytes), name: seeker.documentName ?? "document" };
}

export async function reviewSeeker(
  session: SessionPayload,
  seekerId: string,
  action: "approve" | "reject",
  reason?: string
): Promise<Result<true>> {
  const seeker = await db.jobSeeker.findUnique({
    where: { id: seekerId },
    select: {
      id: true,
      status: true,
      emailVerifiedAt: true,
      phoneVerifiedAt: true,
      telegramVerifiedAt: true,
      documentType: true,
      fullName: true,
    },
  });
  if (!seeker) return err("not_found");
  if (seeker.status === (action === "approve" ? "approved" : "rejected")) {
    return ok(true); // نفس الحالة — لا عمل
  }
  // العامل الثاني: هاتف موثّق أو محادثة تيليغرام موثّقة (بديل OTP معتمد)
  if (!seeker.emailVerifiedAt || (!seeker.phoneVerifiedAt && !seeker.telegramVerifiedAt) || !seeker.documentType) {
    return err("bad_transition"); // لا مصادقة قبل اكتمال التحقق الآلي والوثيقة
  }
  if (action === "reject" && !(reason ?? "").trim()) return err("reason_required");

  await db.jobSeeker.update({
    where: { id: seekerId },
    data: {
      status: action === "approve" ? "approved" : "rejected",
      rejectionReason: action === "reject" ? reason!.trim().slice(0, 500) : null,
      reviewedById: session.sub,
      reviewedAt: new Date(),
      // لا إبطال جلسة عند الرفض: الباحث يرى الحالة والسبب فورًا في بوابته —
      // والتقديم محجوب أصلًا بحساب الحالة (طبقة الخدمة) لا بحياة الجلسة.
    },
  });
  await writeAudit({
    companyId: session.companyId,
    userId: session.sub,
    action: `recruitment.seeker.${action === "approve" ? "approved" : "rejected"}`,
    entity: "JobSeeker",
    entityId: seekerId,
    before: { status: seeker.status },
    after: { status: action === "approve" ? "approved" : "rejected", reason: reason?.trim() ?? null },
  });
  return ok(true);
}

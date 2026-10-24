// HRMP — تنسيق توليد التقارير (SPEC §4.4.1 — المرحلة 7)
// القواعد النافذة هنا:
// 1) RBAC مركزي: كل نوع تقرير بدوره (المشرف بلا أرقام أجور افتراضيًا — سؤال §10-3 حسمه SPEC بالافتراض «لا»)
// 2) الثبات: بصمة المحتوى contentHash (SHA-256 للبيانات المجمدة) — نفس المحتوى يعيد المستند نفسه،
//    والمحتوى المتغيّر يولّد إصدارًا مرقّمًا جديدًا ولا يعدّل القديم أبدًا
// 3) كل توليد/تنزيل يُسجَّل في التدقيق (من، ماذا، متى) — بيانات شخصية ومالية
import { createHash, randomBytes } from "node:crypto";
import { db } from "@/lib/db";
import { requirePermission, AccessError } from "@/lib/rbac";
import { writeAudit } from "@/lib/audit";
import { getSession } from "@/lib/auth/session";
import type { SessionPayload } from "@/lib/auth/jwt";
import type { AnyReportData, ReportFormat, ReportKind, ReportLanguage, ReportOptions } from "./types";
import { KIND_FORMATS, isReportKind, isReportFormat } from "./types";
import {
  buildPayslipReportData,
  buildPayrollSummaryData,
  buildAttendanceReportData,
  buildDeclarationsSummaryData,
  buildComplianceReportData,
  buildPlatformSummaryData,
  ReportDataError,
} from "./data";
import { verifyUrl, verifyUrls } from "./qr";
import { isLocale } from "@/i18n/config";

export { ReportDataError };

// ─── مدخل التوليد ─────────────────────────────────────────────

export type GenerateInput = {
  kind: ReportKind;
  targetId: string;
  format: ReportFormat;
  language: ReportLanguage;
  includeEmployerShare?: boolean;
  year?: number; // لبيانات الحضور
  month?: number;
  /** ملاحظة إدارية تُطبع في المستند — تغييرها يولّد **نسخة جديدة مرقّمة**
   *  (SPEC §4.4.1: «المستندات المعتمدة لا تتغير بعد توليدها… أي تصحيح يولّد
   *  نسخة جديدة مرقّمة») — والنسخة القديمة تبقى ثابتة للتدقيق */
  note?: string;
};

export type GenerateResult = {
  id: string;
  refNumber: string;
  version: number;
  format: ReportFormat;
  language: ReportLanguage;
  kind: ReportKind;
  targetLabel: string;
  fileName: string;
  size: number;
  contentHash: string;
  createdAt: string;
  reused: boolean; // true = مستند موجود سابقًا بنفس المحتوى (الثبات)
};

// ─── RBAC: من يولّد ماذا ─────────────────────────────────────

/** أنواع التقارير المتاحة للدور (لعرضها في الواجهة) */
export function reportKindsForRole(role: string, canSeeWages: boolean): ReportKind[] {
  switch (role) {
    case "super_admin":
      return ["payslip", "payroll_summary", "attendance_statement", "hours_statement", "declarations_summary", "compliance_report", "platform_summary"];
    case "accountant":
      return ["payslip", "payroll_summary", "attendance_statement", "hours_statement", "declarations_summary", "compliance_report"];
    case "admin":
      return ["payslip", "payroll_summary", "attendance_statement", "hours_statement"];
    case "co_admin":
      // بلا أرقام أجور افتراضيًا (SPEC §4.4.1 + §10-3) — الحضور والساعات فقط
      return canSeeWages
        ? ["payslip", "attendance_statement", "hours_statement"]
        : ["attendance_statement", "hours_statement"];
    case "employee":
      return ["payslip", "attendance_statement", "hours_statement"];
    default:
      return [];
  }
}

/** صلاحيات القسيمة: حصة المشغّل تُخفى عن العامل إلا بتفعيل إعداد الشركة */
async function resolveEmployerShare(
  session: SessionPayload,
  kind: ReportKind,
  requested?: boolean
): Promise<boolean> {
  if (kind !== "payslip") return false;
  const role = session.role;
  if (role === "employee") {
    if (requested !== true) return false;
    const settings = await db.companySettings.findUnique({ where: { companyId: session.companyId } });
    return settings?.showEmployerShareToEmployee === true;
  }
  // المدير/المحاسب/المالك: حصة المشغّل معلومة إدارية — تُظهر افتراضيًا
  return true;
}

// ─── الأصل العام للرابط (QR) ─────────────────────────────────

export function publicOrigin(requestOrigin: string): string {
  return (process.env.NEXTAUTH_URL || process.env.APP_PUBLIC_URL || requestOrigin).replace(/\/$/, "");
}

// ─── مرجع فريد ───────────────────────────────────────────────

const REF_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // بلا رموز ملتبسة

function newRefNumber(): string {
  const d = new Date();
  const ymd = `${String(d.getUTCFullYear()).slice(2)}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
  const suffix = Array.from(randomBytes(4))
    .map((b) => REF_ALPHABET[b % REF_ALPHABET.length])
    .join("");
  return `RD-${ymd}-${suffix}`;
}

// ─── الثبات: بصمة المحتوى ────────────────────────────────────

/** إصدار منطق العرض — يُرفع عند أي إصلاح/تحسين في العارض فيبطل المستندات
 * القديمة (النسخة الجديدة تُنشأ والقديمة تبقى للتدقيق — «لا تعديل بعد التوليد») */
const RENDERER_VERSION = 13; // v13: رابطا التحقق في PNG على سطرين متتاليين (كانا متراكبين) + بنّاء ملخص المنصة يطبع المعرّف/البصمة/الرابطان
// v12: الوثيقة تُصدر برابطَي تحقق عامّين (pages.dev + vercel.app) بدل رابط واحد
// v11: العلامات المركّبة (الهمزة تحت الألف) لا تُفصل عن أساسها — كانت تُرسم مربّعًا
// v10: محرّك PDF جديد (pdfkit + Bidi داخلي) — إصلاح العربية المعكوسة + تصميم الهوية
// v9: إصلاح قصّ النصوص عند حواف PNG (محاذاة فيزيائية واعية بالاتجاه في png.ts)
// v8: إصلاح عملة شريط الصافي في PDF (مقاطع الأبجديات — «د.م.» كانت تظهر حرفًا معطوبًا)
// v7: تذييل white-label — إزالة اسم المنتج من تسمية footerOfficial (SPEC §3.2)

function contentHashOf(kind: ReportKind, targetId: string, language: string, data: AnyReportData, options: ReportOptions): string {
  // خيارات مؤثرة في العرض تُضمَّن: (includeEmployerShare للقسيمة · الملاحظة الإدارية للجميع)
  const normalizedOptions = {
    ...(kind === "payslip" ? { es: options.includeEmployerShare === true } : {}),
    ...(options.note ? { n: options.note } : {}),
  };
  const canonical = JSON.stringify({ k: kind, t: targetId, l: language, o: normalizedOptions, rv: RENDERER_VERSION, d: data });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

// ─── أسماء الملفات ───────────────────────────────────────────

function safeFileName(kind: ReportKind, targetLabel: string, language: string, format: ReportFormat): string {
  const base = `${kind}-${targetLabel}`.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  return `${base || kind}-${language}.${format}`;
}

// ─── التوليد الرئيسي ─────────────────────────────────────────

export async function generateReport(
  session: SessionPayload,
  input: GenerateInput,
  requestOrigin: string
): Promise<GenerateResult> {
  const { kind, targetId, format } = input;
  const language = input.language;
  if (!isLocale(language)) throw new ReportDataError(422, "bad_language");
  if (!KIND_FORMATS[kind].includes(format)) throw new ReportDataError(422, "format_not_allowed");

  const role = session.role;
  const companyId = session.companyId;

  // ── RBAC حسب النوع ──
  const settings = await db.companySettings.findUnique({ where: { companyId } });
  const canSeeWages = settings?.showWagesToSupervisor === true;
  const allowed = reportKindsForRole(role, canSeeWages).includes(kind);
  if (!allowed) {
    throw new AccessError(403, role === "co_admin" ? "no_wage_access" : "forbidden");
  }

  // ── بناء البيانات (مع فحوص الملكية) ──
  let data: AnyReportData;
  let targetLabel: string;
  let subjectUserId: string | null = null;

  switch (kind) {
    case "payslip": {
      // العامل يصدّر كشفه فقط
      if (role === "employee") {
        const own = await db.payslip.findFirst({
          where: { id: targetId, companyId, workerUserId: session.sub },
          select: { id: true },
        });
        if (!own) throw new AccessError(403, "not_own_payslip");
      }
      data = await buildPayslipReportData(companyId, targetId);
      targetLabel = (data as { refNumber: string }).refNumber;
      const ps = await db.payslip.findFirst({ where: { id: targetId, companyId }, select: { workerUserId: true } });
      subjectUserId = ps?.workerUserId ?? null;
      break;
    }
    case "payroll_summary": {
      requirePermission(session, "payroll.view");
      data = await buildPayrollSummaryData(companyId, targetId);
      targetLabel = (data as { periodLabel: string }).periodLabel;
      break;
    }
    case "attendance_statement":
    case "hours_statement": {
      // العامل: كشفه فقط — المشرف/المدير: أي عامل بالشركة (نطاق مواقع co_admin يطبَّق على الأحداث)
      let workerUserId = targetId;
      if (role === "employee") {
        workerUserId = session.sub;
      } else {
        // علاج بلاغ المالك 2026-10-25: «self» مسموح للعامل وحده — الأدوار الأخرى
        // ترسل هدفًا حقيقيًا أو تُرفض صراحة بـ422 worker_missing (كانت تمرّ ثم تفشل
        // 404 worker_not_in_company برسالة عامة مضلِّلة).
        if (!workerUserId || workerUserId === "self") {
          throw new ReportDataError(422, "worker_missing");
        }
        const member = await db.userMembership.findFirst({
          where: { userId: targetId, companyId },
          select: { id: true },
        });
        if (!member) throw new ReportDataError(404, "worker_not_in_company");
      }
      const year = input.year ?? new Date().getUTCFullYear();
      const month = input.month ?? new Date().getUTCMonth() + 1;
      let siteIds: string[] | null = null;
      if (role === "co_admin") {
        const { coAdminSiteScope } = await import("@/lib/attendance-service");
        siteIds = await coAdminSiteScope(session);
      }
      data = await buildAttendanceReportData(companyId, workerUserId, year, month, kind, siteIds ?? undefined);
      targetLabel = `${year}-${String(month).padStart(2, "0")}-${workerUserId.slice(-6)}`;
      subjectUserId = workerUserId;
      break;
    }
    case "declarations_summary": {
      requirePermission(session, "declarations.review");
      data = await buildDeclarationsSummaryData(companyId);
      targetLabel = "declarations";
      break;
    }
    case "compliance_report": {
      requirePermission(session, "declarations.review");
      data = await buildComplianceReportData(companyId, targetId);
      targetLabel = (data as { declarationLabel: string }).declarationLabel.replace(/[^A-Za-z0-9._-]+/g, "-");
      break;
    }
    case "platform_summary": {
      if (role !== "super_admin") throw new AccessError(403, "forbidden");
      data = await buildPlatformSummaryData();
      targetLabel = "platform";
      break;
    }
    default:
      throw new ReportDataError(422, "unknown_kind");
  }

  // ── خيارات العرض ──
  const note = normalizeNote(input.note);
  const options: ReportOptions = {
    includeEmployerShare: await resolveEmployerShare(session, kind, input.includeEmployerShare),
    ...(note ? { note } : {}),
  };

  // ── بصمة المحتوى: هل موجود سابقًا؟ (الثبات) ──
  const contentHash = contentHashOf(kind, targetId, language, data, options);
  const existing = await db.generatedDocument.findFirst({
    where: { companyId, kind, targetId, format, language },
    orderBy: { version: "desc" },
  });
  if (existing && existing.contentHash === contentHash) {
    // نفس المحتوى = المستند نفسه (لا إصدار جديد) — التنزيل من النسخة الثابتة
    return {
      id: existing.id,
      refNumber: existing.refNumber,
      version: existing.version,
      format,
      language,
      kind,
      targetLabel: existing.targetLabel,
      fileName: safeFileName(kind, existing.targetLabel, language, format),
      size: existing.fileSize,
      contentHash,
      createdAt: existing.createdAt.toISOString(),
      reused: true,
    };
  }

  // ── التوليد الفعلي (عبر العامل الابن — درس Turbopack، انظر render-worker.ts) ──
  const refNumber = await allocateRefNumber(companyId);
  const generatedAt = new Date().toISOString();
  // الرابطان المطبوعان على الوثيقة (pages.dev + vercel.app) — وQR يحمل الأول
  const links = verifyUrls(refNumber, contentHash);
  const meta = {
    refNumber,
    contentHash,
    verifyUrl: links[0] ?? verifyUrl(publicOrigin(requestOrigin), refNumber, contentHash),
    verifyUrls: links,
    generatedAt,
    generatedBy: session.name || session.email,
  };

  let bytes: Uint8Array;
  try {
    bytes = await renderViaWorker(format, data, language, options, meta);
  } catch (e) {
    const msg = (e as Error).message ?? "";
    if (msg.includes("png_not_supported")) throw new ReportDataError(422, "format_not_allowed");
    throw e;
  }

  const fileHash = createHash("sha256").update(bytes).digest("hex");
  const version = (existing?.version ?? 0) + 1; // المحتوى تغيّر: إصدار جديد والقديم محفوظ

  const row = await db.generatedDocument.create({
    data: {
      companyId,
      kind,
      format,
      language,
      targetId,
      targetLabel,
      subjectUserId,
      version,
      refNumber,
      contentHash,
      fileHash,
      fileSize: bytes.byteLength,
      fileBytes: Buffer.from(bytes),
      optionsJson: JSON.stringify(options),
      createdByUserId: session.sub,
    },
  });

  // كل تصدير يُسجَّل (من، ماذا، متى) — SPEC §4.4.1
  await writeAudit({
    companyId,
    userId: session.sub,
    action: "report.generated",
    entity: "generated_document",
    entityId: row.id,
    after: { kind, format, language, refNumber, version, targetLabel, size: bytes.byteLength },
  });

  return {
    id: row.id,
    refNumber,
    version,
    format,
    language,
    kind,
    targetLabel,
    fileName: safeFileName(kind, targetLabel, language, format),
    size: bytes.byteLength,
    contentHash,
    createdAt: row.createdAt.toISOString(),
    reused: false,
  };
}

/** تطبيع الملاحظة الإدارية: trim + حدّ طول (كي لا يتضخّم الملف) */
export function normalizeNote(note: string | null | undefined): string | undefined {
  const v = (note ?? "").trim().replace(/\r\n/g, "\n");
  if (!v) return undefined;
  return v.slice(0, 2000);
}

/**
 * مراجعة مستند مُولَّد ⇒ **نسخة جديدة مرقّمة** (لا تعديل على القديم).
 * SPEC §4.4.1: «المستندات المعتمدة لا تتغير بعد توليدها: تُحفظ نسخة ثابتة،
 * وأي تصحيح يولّد نسخة جديدة مرقّمة» — فالتسجيل قديم يبقى كما هو للتدقيق.
 */
export async function reviseDocument(
  session: SessionPayload,
  docId: string,
  note: string | null | undefined,
  requestOrigin: string
): Promise<GenerateResult> {
  const row = await db.generatedDocument.findFirst({
    where: { id: docId },
    select: {
      id: true,
      companyId: true,
      kind: true,
      format: true,
      language: true,
      targetId: true,
      optionsJson: true,
    },
  });
  if (!row) throw new ReportDataError(404, "document_not_found");
  if (row.companyId !== session.companyId) throw new AccessError(403, "forbidden");
  if (!isReportKind(row.kind) || !isReportFormat(row.format)) {
    throw new ReportDataError(422, "unknown_kind");
  }
  const prev = parseOptions(row.optionsJson);
  const result = await generateReport(
    session,
    {
      kind: row.kind,
      targetId: row.targetId,
      format: row.format,
      language: row.language as ReportLanguage,
      includeEmployerShare: prev.includeEmployerShare,
      note: normalizeNote(note),
    },
    requestOrigin
  );
  await writeAudit({
    companyId: session.companyId,
    userId: session.sub,
    action: "report.revised",
    entity: "generated_document",
    entityId: result.id,
    after: { kind: row.kind, format: row.format, refNumber: result.refNumber, version: result.version },
  });
  return result;
}

/** خيارات المستند المخزَّنة (JSON) — بأمان (JSON تالف ⇒ خيارات فارغة) */
function parseOptions(json: string | null): ReportOptions {
  if (!json) return {};
  try {
    const parsed = JSON.parse(json) as ReportOptions;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

async function allocateRefNumber(companyId: string): Promise<string> {
  for (let i = 0; i < 5; i++) {
    const ref = newRefNumber();
    const clash = await db.generatedDocument.findFirst({ where: { companyId, refNumber: ref }, select: { id: true } });
    if (!clash) return ref;
  }
  // احتياط بعيد المدى: ملّي ثانية + عشوائية
  return `RD-${Date.now().toString(36).toUpperCase()}-${randomBytes(3).toString("hex").toUpperCase()}`;
}

// ─── العرض عبر عملية ابنة (render-worker.ts) ─────────────────

/**
 * العرض في عملية bun مستقلة — الحزم تُحل بدقة node الحقيقية (بلا طبقة Turbopack
 * التي تحمّل بنية browser فتنكسر العربية). الهاتف الإنتاجي يشغّل الخادم بـ bun
 * فيكون process.execPath = bun. مسار العامل يوجد في dev وstandalone معًا
 * (outputFileTracingIncludes يضم src/lib/reports/**).
 */

/** وقت تشغيل العامل الابن — العامل TypeScript صُمِّم لـ bun (رأس render-worker.ts).
 * الخادم المشغَّل بـ bun (الهاتف الإنتاجي) → execPath نفسه بلا بحث.
 * الخادم المشغَّل بـ node (بيئة التطوير السحابية) → bun من PATH إن وُجد
 * (بلا خطوة البحث هذه يُشغَّل العامل بـ node فيفشل: الحزم الخارجية تُحل ببنية
 * مختلفة عن bun — ثبت في الجلسة السحابية 2026-10-18: api-phase8 73/76 ← 76/76).
 * لا bun في PATH (مثل Vercel serverless) → execPath كما كان (بند Vercel المفتوح). */
let cachedWorkerRuntime: string | undefined;

async function resolveWorkerRuntime(): Promise<string> {
  if (cachedWorkerRuntime) return cachedWorkerRuntime;
  if (/(^|\/)bun(\.exe)?$/i.test(process.execPath)) {
    cachedWorkerRuntime = process.execPath;
    return cachedWorkerRuntime;
  }
  try {
    const { execFile } = await import("node:child_process");
    const bin = process.platform === "win32" ? "where" : "which";
    const out = await new Promise<string>((resolve, reject) => {
      execFile(bin, ["bun"], { encoding: "utf8" }, (err: Error | null, stdout: string) =>
        err ? reject(err) : resolve(stdout)
      );
    });
    const bunPath = out.split("\n")[0]?.trim();
    if (bunPath) {
      cachedWorkerRuntime = bunPath;
      return bunPath;
    }
  } catch {
    /* لا bun في PATH — سقوط إلى execPath */
  }
  cachedWorkerRuntime = process.execPath;
  return cachedWorkerRuntime;
}

async function renderViaWorker(
  format: string,
  data: AnyReportData,
  language: ReportLanguage,
  options: ReportOptions,
  meta: { refNumber: string; contentHash: string; verifyUrl: string; verifyUrls?: string[]; generatedAt: string; generatedBy: string }
): Promise<Uint8Array> {
  const { spawn } = await import("node:child_process");
  const os = await import("node:os");
  const { join } = await import("node:path");
  const { writeFile, readFile, rm } = await import("node:fs/promises");
  const { existsSync } = await import("node:fs");

  const jobId = randomBytes(8).toString("hex");
  const jobPath = join(os.tmpdir(), `hrmp-report-${jobId}.json`);
  const outPath = join(os.tmpdir(), `hrmp-report-${jobId}.bin`);

  // .cjs المترجم أولاً (يعمل تحت node وbun معًا — علاج فشل التوليد على Vercel)،
  // ثم المصدر .ts (يعمل تحت bun حصرًا — وضع dev).
  const workerCandidates = [
    join(process.cwd(), "src", "lib", "reports", "render-worker.cjs"),
    join(process.cwd(), "src", "lib", "reports", "render-worker.ts"),
    join(process.cwd(), "..", "src", "lib", "reports", "render-worker.cjs"),
    join(process.cwd(), "..", "src", "lib", "reports", "render-worker.ts"),
  ];
  const workerPath = workerCandidates.find((c) => existsSync(c));
  if (!workerPath) throw new Error("render_worker_missing");

  await writeFile(jobPath, JSON.stringify({ format, data, language, options, meta }), "utf8");

  try {
    const workerRuntime = await resolveWorkerRuntime();
    await new Promise<void>((resolve, reject) => {
      const child = spawn(workerRuntime, [workerPath, jobPath, outPath], {
        cwd: process.cwd(),
        stdio: ["ignore", "pipe", "pipe"],
        env: process.env,
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
      child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
      child.on("error", (err) => reject(new Error(`render_worker_spawn:${(err as Error).message}`)));
      child.on("close", (code) => {
        if (code === 0) {
          resolve();
          return;
        }
        // رسالة العامل المنظمة إن وُجدت
        try {
          const parsed = JSON.parse(stdout.trim().split("\n").pop() ?? "");
          if (parsed && parsed.ok === false && parsed.error) {
            reject(new Error(String(parsed.error)));
            return;
          }
        } catch {
          /* لا نتيجة منظمة */
        }
        reject(new Error(`render_worker_failed:${code}:${(stderr || stdout).slice(0, 300)}`));
      });
    });
    return new Uint8Array(await readFile(outPath));
  } finally {
    await rm(jobPath, { force: true }).catch(() => undefined);
    await rm(outPath, { force: true }).catch(() => undefined);
  }
}

// ─── التنزيل (مع فحص الوصول) ─────────────────────────────────

export type StoredDocument = {
  row: {
    id: string;
    companyId: string;
    kind: string;
    format: string;
    language: string;
    targetLabel: string;
    refNumber: string;
    fileBytes: Uint8Array;
    fileSize: number;
    version: number;
    createdByUserId: string;
    subjectUserId: string | null;
  };
  fileName: string;
  contentType: string;
};

const CONTENT_TYPES: Record<string, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  png: "image/png",
  csv: "text/csv; charset=utf-8",
};

export async function getDocumentForDownload(session: SessionPayload, docId: string): Promise<StoredDocument> {
  const row = await db.generatedDocument.findFirst({
    where: { id: docId },
    select: {
      id: true,
      companyId: true,
      kind: true,
      format: true,
      language: true,
      targetLabel: true,
      refNumber: true,
      fileBytes: true,
      fileSize: true,
      version: true,
      createdByUserId: true,
      subjectUserId: true,
    },
  });
  if (!row) throw new ReportDataError(404, "document_not_found");

  // الوصول: نفس الشركة + (مستندك الشخصي أو أنشأته أو دورًا يرى نوعه)
  if (row.companyId !== session.companyId) {
    const sameSubject = row.subjectUserId === session.sub;
    if (!sameSubject) throw new AccessError(403, "cross_company_document");
  }
  if (session.role === "employee" && row.subjectUserId !== session.sub && row.createdByUserId !== session.sub) {
    throw new AccessError(403, "not_own_document");
  }

  const settings = await db.companySettings.findUnique({ where: { companyId: session.companyId } });
  const canSeeWages = settings?.showWagesToSupervisor === true;
  const allowedKinds = reportKindsForRole(session.role, canSeeWages);
  if (!allowedKinds.includes(row.kind as ReportKind)) {
    throw new AccessError(403, "kind_not_allowed");
  }

  return {
    row,
    fileName: safeFileName(row.kind as ReportKind, row.targetLabel, row.language, row.format as ReportFormat),
    contentType: CONTENT_TYPES[row.format] ?? "application/octet-stream",
  };
}

// ─── سجل التصديرات (للتدقيق والعرض) ──────────────────────────

export async function listRecentDocuments(session: SessionPayload, limit = 20) {
  const where =
    session.role === "employee"
      ? { companyId: session.companyId, subjectUserId: session.sub }
      : { companyId: session.companyId };

  // السجل نفسه يخضع لمصفوفة الأنواع: المشرف لا يرى حتى وجود قسائم (درس E2E)
  const settings = await db.companySettings.findUnique({ where: { companyId: session.companyId } });
  const canSeeWages = settings?.showWagesToSupervisor === true;
  const allowedKinds = reportKindsForRole(session.role, canSeeWages);

  const docs = await db.generatedDocument.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: limit * 2,
    select: {
      id: true,
      kind: true,
      format: true,
      language: true,
      targetLabel: true,
      refNumber: true,
      version: true,
      fileSize: true,
      createdAt: true,
      subjectUserId: true,
      createdByUserId: true,
    },
  });

  const creatorIds = [...new Set(docs.map((d) => d.createdByUserId))];
  const creators = creatorIds.length
    ? await db.user.findMany({ where: { id: { in: creatorIds } }, select: { id: true, fullName: true } })
    : [];
  const nameById = new Map(creators.map((c) => [c.id, c.fullName]));

  return docs
    .filter((d) => allowedKinds.includes(d.kind as ReportKind))
    .slice(0, limit)
    .map((d) => ({
      ...d,
      createdByName: nameById.get(d.createdByUserId) ?? "—",
      createdAt: d.createdAt.toISOString(),
    }));
}

// ─── التحقق العام (QR) ───────────────────────────────────────

export type VerifyResult =
  | { valid: true; refNumber: string; kind: string; format: string; language: string; version: number; targetLabel: string; companyLegalName: string; generatedAt: string; contentHash: string; hashMatches: boolean }
  | { valid: false; reason: "not_found" | "hash_mismatch"; refNumber?: string };

// ─── التحقق العام الفدرالي (بلاغ المالك 2026-10-23) ──────────
// الوثائق تُولَّد على الخادم المرجعي (الهاتف، عبر workers.dev)، أما بوابتا
// pages.dev و vercel.app فتعملان على لقطة Vercel المؤقتة التي لا تحتوي وثائق
// الإنتاج — فكان الرابط يعمل والحكم «الوثيقة غير حقيقية» (not_found).
// العلاج: إن لم يجد الحكم المحلي الوثيقة، تسأل البوابة الخادم المرجعي مباشرة
// وتنسخ حكمه (بلا كشف أي معلومة إضافية — نقطة التحقق عامة ومحدودة أصلًا).
// (إعادة التسمية 2026-10-24): الاسم الجديد HRMP_VERIFY_FALLBACK_ORIGIN يُقرأ أولًا
// والقديم FWMS_VERIFY_FALLBACK_ORIGIN يُقبل للتوافق مع النشر القائم.
const FEDERATED_VERIFY_ORIGIN = (
  process.env.HRMP_VERIFY_FALLBACK_ORIGIN ||
  process.env.FWMS_VERIFY_FALLBACK_ORIGIN ||
  (process.env.VERCEL ? "https://fwms.tarikc.workers.dev" : "")
)
  .trim()
  .replace(/\/+$/, "");

async function verifyAtAuthoritativeServer(refNumber: string, h?: string | null): Promise<VerifyResult | null> {
  if (!FEDERATED_VERIFY_ORIGIN) return null;
  try {
    const query = h ? `?h=${encodeURIComponent(h)}` : "";
    const res = await fetch(`${FEDERATED_VERIFY_ORIGIN}/api/reports/verify/${encodeURIComponent(refNumber)}${query}`, {
      cache: "no-store",
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(8000),
    });
    const body = (await res.json()) as VerifyResult;
    if (!body || typeof body.valid !== "boolean") return null;
    return body;
  } catch {
    return null; // تعذّر بلوغ المرجع: يبقى الحكم المحلي كما هو (لا ندّعي أصالة بلا دليل)
  }
}

async function verifyLocally(refNumber: string, h?: string | null): Promise<VerifyResult> {
  const doc = await db.generatedDocument.findFirst({
    where: { refNumber },
    orderBy: { createdAt: "desc" },
    include: { company: { select: { legalName: true, status: true } } },
  });
  if (!doc) return { valid: false, reason: "not_found" };

  const hashMatches = !h || h === doc.contentHash.slice(0, h.length);
  if (!hashMatches) {
    return { valid: false, reason: "hash_mismatch", refNumber: doc.refNumber };
  }

  return {
    valid: true,
    refNumber: doc.refNumber,
    kind: doc.kind,
    format: doc.format,
    language: doc.language,
    version: doc.version,
    targetLabel: doc.targetLabel,
    companyLegalName: doc.company.legalName,
    generatedAt: doc.createdAt.toISOString(),
    contentHash: doc.contentHash,
    hashMatches,
  };
}

export async function verifyDocumentByRef(refNumber: string, h?: string | null): Promise<VerifyResult> {
  const local = await verifyLocally(refNumber, h);
  if (local.valid) return local;
  const federated = await verifyAtAuthoritativeServer(refNumber, h);
  // حكم المرجع يُقدَّم إذا نفى أو **وجد المرجع وبصمته لا تطابق** (تزييف): أمتن دلالةً
  // من «غير موجود» في نسخة لقطة. وإن لم يجد المرجع نحتفظ بالحكم المحلي كما هو.
  if (federated && (federated.valid || federated.reason === "hash_mismatch")) return federated;
  return local;
}

// ─── الجلسة الكاملة (للـ API routes) ─────────────────────────

export async function requireSession(): Promise<SessionPayload> {
  const session = await getSession();
  if (!session) throw new AccessError(401, "unauthenticated");
  return session;
}

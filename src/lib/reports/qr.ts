// HRMP — علامة التحقق (SPEC §4.4.1): رقم مرجعي + QR يتحقق منه الخادم من صحة الكشف
// QR يحمل رابط التحقق العام: {origin}/verify/{ref}?h={hash16} — يفتح صفحة عامة تعرض الأصالة
import QRCode from "qrcode";

export const VERIFY_HASH_PREFIX = 16; // أول 16 حرفًا سداسيًا من SHA-256 في الرابط

/** رابط التحقق العام — الأصل من إعدادات النشر إن ضُبط وإلا من الطلب */
export function verifyUrl(origin: string, refNumber: string, fileHash: string): string {
  const base = (process.env.NEXTAUTH_URL || process.env.APP_PUBLIC_URL || origin).replace(/\/$/, "");
  return `${base}/verify/${encodeURIComponent(refNumber)}?h=${fileHash.slice(0, VERIFY_HASH_PREFIX)}`;
}

/** بوابات التحقق العامة المطبوعة على الوثيقة (بلاغ المالك 2026-10-23):
 * «الوثيقة المصدرة يجب أن تصدر برابطين: pages.dev و vercel.app» — روابط مستقلة
 * حتى يبقى التحقق ممكنًا إن تعذّرت إحداها، ومعها QR يحمل الرابط الأول.
 * (إعادة التسمية 2026-10-24): البوابة الأولى صارت hrmp.pages.dev (بوابة المنصة
 * الجديدة — تخدم الخادم المرجعي نفسه).
 * (علاج بلاغ المالك 2026-10-25 «يظهر رابط التحقق للنسخة القديمة ولا يظهر رابط
 * ڤيرسيل»): الثانية صارت hrmp.vercel.app — التي صارت بوابة إلى الخادم المرجعي
 * نفسه (rewrites في next.config.ts عند VERCEL=1) فصار الرابط يتحقق من بيانات
 * الإنتاج مباشرةً. حُذفت القديمتان fwms-dg8.pages.dev وfwms-orpin.vercel.app
 * (الأولى تظهر في الوثائق كنطاق النسخة القديمة، والثانية لم تعد قائمة أصلًا).
 * تُضبط القائمة عبر HRMP_PUBLIC_VERIFY_ORIGINS (مفصولة بفواصل؛ والاسم القديم
 * FWMS_PUBLIC_VERIFY_ORIGINS يُقبل أيضًا للتوافق) وإلا فالافتراضي المعتمد. */
export const DEFAULT_PUBLIC_VERIFY_ORIGINS = [
  "https://hrmp.pages.dev",
  "https://hrmp.vercel.app",
];

/** بوابات التحقق النافذة (بلا تكرار، بلا شرطة أخيرة) */
export function publicVerifyOrigins(): string[] {
  const raw = (process.env.HRMP_PUBLIC_VERIFY_ORIGINS ?? process.env.FWMS_PUBLIC_VERIFY_ORIGINS ?? "").trim();
  const list = (raw ? raw.split(",") : DEFAULT_PUBLIC_VERIFY_ORIGINS)
    .map((origin) => origin.trim().replace(/\/+$/, ""))
    .filter(Boolean);
  const unique = [...new Set(list)];
  return unique.length ? unique : DEFAULT_PUBLIC_VERIFY_ORIGINS;
}

/** رابط تحقق على بوابة محددة (نفس صيغة verifyUrl لكن بأصل صريح لا من البيئة) */
export function verifyUrlAt(origin: string, refNumber: string, fileHash: string): string {
  const base = origin.replace(/\/+$/, "");
  return `${base}/verify/${encodeURIComponent(refNumber)}?h=${fileHash.slice(0, VERIFY_HASH_PREFIX)}`;
}

/** روابط التحقق المطبوعة على الوثيقة — رابط لكل بوابة عامة (الأول هو محتوى QR) */
export function verifyUrls(refNumber: string, fileHash: string): string[] {
  return publicVerifyOrigins().map((origin) => verifyUrlAt(origin, refNumber, fileHash));
}

/** QR كـ PNG buffer (لتضمينه في PDF/DOCX/PNG) */
export async function qrPngBuffer(url: string, size = 220): Promise<Buffer> {
  return QRCode.toBuffer(url, {
    type: "png",
    width: size,
    margin: 1,
    errorCorrectionLevel: "M",
    color: { dark: "#1e3a5f", light: "#ffffff" },
  });
}

/** QR كـ data URL (مباشر لـ @react-pdf Image وSVG) */
export async function qrDataUrl(url: string, size = 220): Promise<string> {
  const buf = await qrPngBuffer(url, size);
  return `data:image/png;base64,${buf.toString("base64")}`;
}

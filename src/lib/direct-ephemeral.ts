// HRMP — الوسائط المرئية المؤقتة: الفيديو (بلاغ المالك 2026-10-25)
// «الفيديو المرسل لا يمسح بعد استهلاكه مثل الأوديو المرسل» — نفس سياسة
// voice-ephemeral.ts حرفيًا مطبَّقة على رسائل DirectMessage من نوع video:
//  - الاستهلاك = أول مشاهدة من المستقبِل (viewedAt) أو من مشرف voice.admin
//    (المعني بالأمر عبر consumed) ⇒ حمولة الفيديو (BLOB) تُفرَّغ فورًا.
//  - ما لم يُستهلك يُمسح بعد 72 ساعة (TTL) — مسح كسول عند القراءات (serverless).
//  - السجل الوصفي (المرسل/المتلقّي/المدة/الأوقات) يبقى للتدقيق — بلا أي
//    محتوى، والبث بعدها يرجع 410 Gone.
// الصور والمواقع خارج هذه السياسة (بلاغ المالك ذكر الفيديو حصرًا) — تبقى
// ثابتة مع تعليم viewedAt فقط كما كان.
import { db } from "@/lib/db";

/** عمر رسالة الفيديو غير المستهلكة قبل المسح التلقائي — نفس الصوتيات */
export const DIRECT_VIDEO_TTL_MS = 72 * 60 * 60 * 1000; // 72 ساعة

const EMPTY_BYTES = Buffer.alloc(0);

/** مسح حمولة رسالة مرئية واحدة (إن لم تُمسح سابقًا) — بمن مسحها */
export async function purgeDirectMessage(id: string, byUserId: string): Promise<boolean> {
  const res = await db.directMessage.updateMany({
    where: { id, purgedAt: null },
    data: { media: EMPTY_BYTES, purgedAt: new Date(), purgedBy: byUserId },
  });
  return res.count > 0;
}

/** المسح الكسول لكل رسائل الفيديو منتهية العمر غير المستهلكة — يُستدعى عند
 *  قراءة الخيوط. رخيصة: عمود purgedAt مفهرس وشروطها انتقائية (kind = video). */
export async function purgeExpiredDirectVideos(): Promise<number> {
  const cutoff = new Date(Date.now() - DIRECT_VIDEO_TTL_MS);
  const res = await db.directMessage.updateMany({
    where: { kind: "video", purgedAt: null, createdAt: { lt: cutoff } },
    data: { media: EMPTY_BYTES, purgedAt: new Date(), purgedBy: "ttl" },
  });
  return res.count;
}

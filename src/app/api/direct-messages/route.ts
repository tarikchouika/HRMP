// HRMP — الرسائل المرئية والموقعية المباشرة (بلاغ المالك 2026-10-24)
// ---------------------------------------------------------------------------
// «خاصيات المراسلة الصوتية والبصرية والموقع الجغرافي بين المستخدمين يجب
//  مزامنتها بشكل أني عبر المنصة بشكل مباشر حسب الصلاحيات» — هذا المسار الجزء
// المرئي والموقعي منه؛ الصوتي يبقى في api/voice-messages. العزل واحد (مكتبة
// direct-messaging.ts): العضو داخل فريقه فقط، والإشراف يخاطب الجميع.
//
//  - kind=photo:  camera.capture → JPEG (getUserMedia environment) ≤ 3MB
//  - kind=video:  MediaRecorder (video+audio) ≤ 60ث ≤ 8MB (webm/mp4)
//  - kind=location: navigator.geolocation — lat/lng/accuracyM بلا حمولة
// حدود: 30 رسالة/ساعة/مستخدم (نفس مبدأ الصوتيات) + تدقيق كامل.
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { AccessError, roleHas } from "@/lib/rbac";
import { hasPermission } from "@/lib/delegations";
import { rateLimit } from "@/lib/rate-limit";
import { writeAudit } from "@/lib/audit";
import { messagingAccess, canConverseWith, canOpenThread, contextGroupId, hasExistingThread, isSupervisor, latestThreadGroupId } from "@/lib/direct-messaging";
import { purgeExpiredDirectVideos } from "@/lib/direct-ephemeral";

export const DIRECT_PHOTO_MAX_BYTES = 3_000_000;
export const DIRECT_VIDEO_MAX_BYTES = 8_000_000;
export const DIRECT_VIDEO_MAX_DURATION_SEC = 60;

const PHOTO_MIMES = new Set(["image/jpeg", "image/png", "image/webp"]);
const VIDEO_MIMES = new Set(["video/webm", "video/mp4", "video/quicktime"]);
// بعض البيئات ترسل webm بوسم صوتي — نفس درس المرحلة 9؛ نقبله للفيديو ونطبّعه
const VIDEO_MIME_NORMALIZE: Record<string, string> = { "audio/webm": "video/webm" };

const listMeta = (m: {
  id: string;
  senderId: string;
  recipientId: string;
  kind: string;
  mime: string;
  sizeBytes: number;
  durationSec: number;
  lat: number | null;
  lng: number | null;
  accuracyM: number | null;
  viewedAt: Date | null;
  purgedAt: Date | null;
  purgedBy: string | null;
  createdAt: Date;
}) => ({
  id: m.id,
  senderId: m.senderId,
  recipientId: m.recipientId,
  kind: m.kind,
  durationSec: m.durationSec,
  sizeBytes: m.sizeBytes,
  lat: m.lat,
  lng: m.lng,
  accuracyM: m.accuracyM,
  viewedAt: m.viewedAt ? m.viewedAt.toISOString() : null,
  purgedAt: m.purgedAt ? m.purgedAt.toISOString() : null,
  purgedBy: m.purgedBy,
  createdAt: m.createdAt.toISOString(),
});

export async function GET(req: NextRequest) {
  try {
    const session = await getSession();
    if (!session) throw new AccessError(401, "unauthenticated");
    const canUse = roleHas(session.role, "voice.use") || (await hasPermission(session as never, "voice.use"));
    if (!canUse) throw new AccessError(403, "forbidden");

    const url = new URL(req.url);
    const withParam = url.searchParams.get("with");
    if (!withParam) return NextResponse.json({ error: "invalid_input" }, { status: 400 });

    const access = await messagingAccess(session);
    if (!(await canOpenThread(access, session, withParam))) {
      throw new AccessError(403, "forbidden");
    }
    // مسح كسول لرسائل الفيديو منتهية العمر (TTL 72 ساعة) — نفس مبدأ الصوتيات
    await purgeExpiredDirectVideos();
    const messages = await db.directMessage.findMany({
      where: {
        OR: [
          { senderId: session.sub, recipientId: withParam },
          { senderId: withParam, recipientId: session.sub },
        ],
      },
      orderBy: { createdAt: "asc" },
      take: 200,
    });
    return NextResponse.json({ messages: messages.map(listMeta) });
  } catch (error) {
    if (error instanceof AccessError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error("[direct-messages GET]", error);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}

const sendMetaSchema = z.object({
  to: z.string().min(1).max(64),
  kind: z.enum(["photo", "video", "location"]),
  durationSec: z.coerce.number().int().min(0).max(DIRECT_VIDEO_MAX_DURATION_SEC).default(0),
  lat: z.coerce.number().min(-90).max(90).optional(),
  lng: z.coerce.number().min(-180).max(180).optional(),
  accuracyM: z.coerce.number().min(0).max(100_000).optional(),
});

export async function POST(req: NextRequest) {
  try {
    const session = await getSession();
    if (!session) throw new AccessError(401, "unauthenticated");
    const canUse = roleHas(session.role, "voice.use") || (await hasPermission(session as never, "voice.use"));
    if (!canUse) throw new AccessError(403, "forbidden");

    const rl = rateLimit(`direct:${session.sub}`, 30, 60 * 60 * 1000);
    if (!rl.allowed) {
      return NextResponse.json(
        { error: "rate_limited", retryAfterMs: rl.retryAfterMs },
        { status: 429, headers: { "Retry-After": String(Math.ceil(rl.retryAfterMs / 1000)) } },
      );
    }

    const form = await req.formData().catch(() => null);
    if (!form) return NextResponse.json({ error: "invalid_input" }, { status: 400 });
    const parsed = sendMetaSchema.safeParse({
      to: form.get("to"),
      kind: form.get("kind"),
      durationSec: form.get("durationSec") ?? 0,
      lat: form.get("lat") ?? undefined,
      lng: form.get("lng") ?? undefined,
      accuracyM: form.get("accuracyM") ?? undefined,
    });
    if (!parsed.success) return NextResponse.json({ error: "invalid_input" }, { status: 400 });
    const { kind } = parsed.data;

    const access = await messagingAccess(session);
    const conversable = await canConverseWith(access, session, parsed.data.to);
    // استثناء الخيط القائم: للطرف المخوّل فقط (إشراف خاطب العامل) — خيط
    // عضوين عاديين يظل مقيّدًا بالعضوية: إزالة العضو تقطعه (اختبار المرحلة 9)
    const otherIsSupervisor = conversable ? false : await isSupervisor(session.companyId, parsed.data.to);
    const threadExists = otherIsSupervisor ? await hasExistingThread(session.sub, parsed.data.to) : false;
    if (!conversable && !threadExists) {
      throw new AccessError(403, "forbidden");
    }

    // فريق السياق: ميراثه من الخيط القائم عند الرد (خيط بدأه طرف مخوّل) —
    // وإلا حسابه للخيط الجديد؛ الرد لا يُسقط بـ409 ولا يفتح بابًا عابرًا للفرق
    const groupId = conversable
      ? await contextGroupId(access, session, parsed.data.to)
      : await latestThreadGroupId(session.sub, parsed.data.to);
    if (!groupId && !access.admin && !threadExists) {
      // عضو بلا فريق مشترك مع المخاطَب: العزل يمنع الإرسال (الإشرافي يجتازه)
      return NextResponse.json({ error: "no_shared_team" }, { status: 409 });
    }

    let media: Uint8Array<ArrayBuffer> | null = null;
    let mime = "";
    let sizeBytes = 0;

    if (kind === "location") {
      if (parsed.data.lat == null || parsed.data.lng == null) {
        return NextResponse.json({ error: "invalid_input" }, { status: 400 });
      }
    } else {
      const file = form.get("media");
      if (!(file instanceof File)) return NextResponse.json({ error: "invalid_input" }, { status: 400 });
      let rawMime = (file.type || "").split(";")[0].trim().toLowerCase();
      rawMime = VIDEO_MIME_NORMALIZE[rawMime] ?? rawMime;
      const limit = kind === "photo" ? DIRECT_PHOTO_MAX_BYTES : DIRECT_VIDEO_MAX_BYTES;
      const allowed = kind === "photo" ? PHOTO_MIMES : VIDEO_MIMES;
      if (!allowed.has(rawMime)) {
        return NextResponse.json({ error: kind === "photo" ? "not_image" : "not_video" }, { status: 415 });
      }
      if (file.size === 0 || file.size > limit) {
        return NextResponse.json({ error: kind === "photo" ? "photo_too_large" : "video_too_large" }, { status: 413 });
      }
      media = new Uint8Array(await file.arrayBuffer());
      mime = rawMime;
      sizeBytes = media.byteLength;
    }

    const created = await db.directMessage.create({
      data: {
        companyId: session.companyId,
        groupId,
        senderId: session.sub,
        recipientId: parsed.data.to,
        kind,
        mime,
        sizeBytes,
        durationSec: kind === "video" ? parsed.data.durationSec : 0,
        lat: kind === "location" ? (parsed.data.lat ?? null) : null,
        lng: kind === "location" ? (parsed.data.lng ?? null) : null,
        accuracyM: kind === "location" ? (parsed.data.accuracyM ?? null) : null,
        media,
      },
      select: { id: true, createdAt: true },
    });

    await writeAudit({
      companyId: session.companyId,
      userId: session.sub,
      action: "direct_message.send",
      entity: "direct_message",
      entityId: created.id,
      after: {
        to: parsed.data.to,
        kind,
        sizeBytes,
        durationSec: parsed.data.durationSec,
        groupId,
        lat: parsed.data.lat ?? null,
        lng: parsed.data.lng ?? null,
      },
    });

    return NextResponse.json({
      ok: true,
      message: { id: created.id, createdAt: created.createdAt.toISOString() },
    });
  } catch (error) {
    if (error instanceof AccessError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error("[direct-messages POST]", error);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}

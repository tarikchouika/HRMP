"use client";

// HRMP — واجهة المراسلة الموحدة (المرحلة 9 + بلاغ المالك 2026-10-24)
// ---------------------------------------------------------------------------
// محادثات مباشرة بين المستخدمين بكل الوسائط حسب الصلاحيات:
//   صوت (Mic) · صورة من الكاميرا · فيديو قصير من الكاميرا · مشاركة الموقع
//   + اتصال مباشر آنٍ صوت/صورة (أزرار الهاتف — WebRTC P2P لا يُخزَّن في المنصة)
// العزل في الخادم حصرًا (direct-messaging.ts): العامل/الحرفي/القائد داخل فريقه
// فقط، والوضع الإشرافي يصل إلى الجميع + تصفح رسائل أي فريق (صوتيات).
// المزامنة الآنية (SSE /api/realtime): الرسائل تصل لحظة إرسالها — والاستطلاع
// يبقى احتياطًا (60ث) لو رُفضت القناة. التسجيل: صوت ≤120ث، فيديو ≤60ث،
// صورة JPEG ≤3MB، فيديو ≤8MB؛ الإرسال multipart.
// الصوتيات مؤقتة (بلاغ المالك 2026-10-24): استماع المتلقّي أو المعني بالأمر
// (إشراف) يستهلكها فتُمسح فورًا؛ وما لم يُستهلك يُمسح بعد 72 ساعة — والسجل
// الوصفي وحده يبقى للتدقيق (حالة «مُستهلكة» غير قابلة للتشغيل).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Camera,
  CheckCheck,
  Clock,
  Image as ImageIcon,
  LoaderCircle,
  MapPin,
  Mic,
  Pause,
  Phone,
  Play,
  Radio,
  RefreshCcw,
  ShieldCheck,
  Square,
  Trash2,
  Users,
  Video,
  X,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useI18n } from "@/i18n/provider";
import { ListState, apiRequest } from "@/components/hrmp/org-bits";
import { jobTitleLabel } from "@/lib/job-titles";
import { openRealtime, type RealtimeHandle } from "@/lib/realtime-client";
import { requestStartCall } from "@/lib/call-events";

type Contact = { userId: string; fullName: string; role: string; jobTitleKey: string | null };
type VoiceMsg = {
  id: string;
  senderId: string;
  recipientId: string;
  durationSec: number;
  sizeBytes: number;
  listenedAt: string | null;
  purgedAt: string | null; // استُهلكت ومُسح محتواها (متلقٍّ/إشراف/TTL)
  purgedBy: string | null;
  createdAt: string;
};
type DirectMsg = {
  id: string;
  senderId: string;
  recipientId: string;
  kind: "photo" | "video" | "location";
  durationSec: number;
  sizeBytes: number;
  lat: number | null;
  lng: number | null;
  accuracyM: number | null;
  viewedAt: string | null;
  purgedAt: string | null; // (بلاغ المالك 2026-10-25) استُهلك الفيديو ومُسحت حمولته — غير قابل للتشغيل
  purgedBy: string | null;
  createdAt: string;
};

const MAX_RECORD_SEC = 120;
const MAX_VIDEO_SEC = 60;
// الاستطلاع احتياط فقط — القناة الآنية (SSE) توصل الرسائل خلال ~2ث
const POLL_FALLBACK_MS = 60_000;

// قيمة حارسة لأن SelectItem يرفض القيمة الفارغة (درس المرحلة 2)
const NONE = "none";

function hoursLabel(sec: number): string {
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
}

/** dataURL ⇒ Blob بلا fetch (سقوط atob لبيئات بلا canvas.toBlob) —
 *  fetch(data:) محجوب بسياسة CSP connect-src فلا يُستعمل إطلاقًا (جذر خلل
 *  إرسال الصورة 2026-10-25) */
function dataUrlToBlob(dataUrl: string): Blob | null {
  try {
    const comma = dataUrl.indexOf(",");
    if (comma < 0) return null;
    const meta = dataUrl.slice(5, comma); // "image/jpeg;base64"
    const mime = meta.split(";")[0] || "image/jpeg";
    const raw = atob(dataUrl.slice(comma + 1));
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
    return new Blob([bytes], { type: mime });
  } catch {
    return null;
  }
}

export function VoiceConsole({ myUserId }: { myUserId: string }) {
  const { t, dir, locale } = useI18n();
  const BackArrow = dir === "rtl" ? ArrowRight : ArrowLeft;

  const [mode, setMode] = useState<"team" | "admin" | null>(null);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const [selected, setSelected] = useState<Contact | null>(null);
  const [messages, setMessages] = useState<VoiceMsg[]>([]);
  const [dmMessages, setDmMessages] = useState<DirectMsg[]>([]);
  const [threadLoading, setThreadLoading] = useState(false);

  // وضع الإشراف: تصفح رسائل فريق
  const [adminGroups, setAdminGroups] = useState<{ id: string; name: string }[]>([]);
  const [browseGroup, setBrowseGroup] = useState<string>(NONE);
  const [browseMessages, setBrowseMessages] = useState<VoiceMsg[]>([]);

  // غير المقروء آنيًا (قبل فتح المحادثة) — من أحداث SSE
  const [liveUnread, setLiveUnread] = useState<Record<string, number>>({});
  // حالة القناة الآنية: true = موصولة
  const [live, setLive] = useState(false);

  // التسجيل الصوتي
  const [recording, setRecording] = useState(false);
  const [recordSec, setRecordSec] = useState(0);
  const [sending, setSending] = useState(false);
  const [micError, setMicError] = useState<string | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const autoStopRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // التشغيل
  const [playingId, setPlayingId] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  // الكاميرا (صورة/فيديو) — حوار موحّد
  const [camOpen, setCamOpen] = useState(false);
  const [camMode, setCamMode] = useState<"photo" | "video">("photo");
  const [camFacing, setCamFacing] = useState<"environment" | "user">("environment");
  const [camError, setCamError] = useState<string | null>(null);
  const [camBusy, setCamBusy] = useState(false);
  const camVideoRef = useRef<HTMLVideoElement | null>(null);
  const camStreamRef = useRef<MediaStream | null>(null);
  const camRecorderRef = useRef<MediaRecorder | null>(null);
  const camChunksRef = useRef<BlobPart[]>([]);
  const camTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const camAutoStopRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [camRecording, setCamRecording] = useState(false);
  const [camRecordSec, setCamRecordSec] = useState(0);
  const [photoPreview, setPhotoPreview] = useState<{ url: string; blob: Blob } | null>(null); // (بلاغ المالك 2026-10-25) Blob مباشرة — كان dataURL يُجلب بـfetch المحجوب بـCSP connect-src فيفشل إرسال الصورة
  const [videoPreview, setVideoPreview] = useState<{ url: string; blob: Blob; durationSec: number } | null>(null);

  // عارض الصورة/الفيديو داخل المحادثة
  const [viewer, setViewer] = useState<DirectMsg | null>(null);

  // مشاركة الموقع
  const [locBusy, setLocBusy] = useState(false);
  const [dmError, setDmError] = useState<string | null>(null);

  const realtimeRef = useRef<RealtimeHandle | null>(null);

  const loadContacts = useCallback(async () => {
    try {
      const data = await apiRequest<{ mode: "team" | "admin"; contacts: Contact[] }>(
        "/api/voice-messages?contacts=1",
      );
      setMode(data.mode);
      setContacts(data.contacts);
      if (data.mode === "admin") {
        try {
          const g = await apiRequest<{ groups: { id: string; name: string; status: string }[] }>(
            "/api/worker-groups",
          );
          setAdminGroups(g.groups.filter((x) => x.status === "active").map((x) => ({ id: x.id, name: x.name })));
        } catch {
          /* قائمة الفرق تحسينية — فشلها لا يوقف الصوتيات */
        }
      }
      setError(false);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  const loadThread = useCallback(async (other: string) => {
    setThreadLoading(true);
    try {
      const [voiceData, directData] = await Promise.all([
        apiRequest<{ messages: VoiceMsg[] }>(`/api/voice-messages?with=${encodeURIComponent(other)}`),
        apiRequest<{ messages: DirectMsg[] }>(`/api/direct-messages?with=${encodeURIComponent(other)}`).catch(
          () => ({ messages: [] as DirectMsg[] }),
        ),
      ]);
      setMessages(voiceData.messages);
      setDmMessages(directData.messages ?? []);
      // فتح المحادثة يمحو عدّاد الآني غير المقروء لهذا المرسل
      setLiveUnread((prev) => {
        if (!prev[other]) return prev;
        const next = { ...prev };
        delete next[other];
        return next;
      });
    } catch {
      setMessages([]);
    } finally {
      setThreadLoading(false);
    }
  }, []);

  const loadBrowse = useCallback(async (groupId: string) => {
    if (groupId === NONE) {
      setBrowseMessages([]);
      return;
    }
    try {
      const data = await apiRequest<{ group: { id: string; name: string }; messages: VoiceMsg[] }>(
        `/api/voice-messages?group=${encodeURIComponent(groupId)}`,
      );
      setBrowseMessages(data.messages);
    } catch {
      setBrowseMessages([]);
    }
  }, []);

  useEffect(() => {
    void loadContacts();
  }, [loadContacts]);

  // المزامنة الآنية (SSE): تحديث فوري للمحادثة المفتوحة + عدّادات غير المقروء
  useEffect(() => {
    realtimeRef.current = openRealtime((ev) => {
      if (ev.type === "hello") {
        setLive(true);
        return;
      }
      if (ev.type === "voice" || ev.type === "dm") {
        const senders = new Set(ev.items.map((i) => i.from).filter(Boolean) as string[]);
        // المحادثة المفتوحة مع أحدهم؟ تحميل فوري — وإلا عدّاد آني غير مقروء
        if (selected && senders.has(selected.userId)) {
          void loadThread(selected.userId);
        } else {
          setLiveUnread((prev) => {
            const next = { ...prev };
            for (const s of senders) next[s] = (next[s] ?? 0) + 1;
            return next;
          });
        }
      }
    });
    return () => {
      realtimeRef.current?.close();
      realtimeRef.current = null;
    };
  }, []);

  // احتياط الاستطلاع (لو رُفضت القناة الآنية أو انقطعت) — يظل العمل
  useEffect(() => {
    if (!selected) return;
    void loadThread(selected.userId);
    const id = setInterval(() => {
      if (document.visibilityState === "visible") void loadThread(selected.userId);
    }, POLL_FALLBACK_MS);
    return () => clearInterval(id);
  }, [selected, loadThread]);

  useEffect(() => {
    if (browseGroup !== NONE) void loadBrowse(browseGroup);
  }, [browseGroup, loadBrowse]);

  // ── التسجيل الصوتي ──
  function stopTimer() {
    if (timerRef.current) clearInterval(timerRef.current);
    if (autoStopRef.current) clearTimeout(autoStopRef.current);
    timerRef.current = null;
    autoStopRef.current = null;
  }

  function cleanupRecorder() {
    recorderRef.current?.stream.getTracks().forEach((tk) => tk.stop());
    recorderRef.current = null;
    chunksRef.current = [];
    setRecording(false);
    setRecordSec(0);
    stopTimer();
  }

  async function startRecording() {
    setMicError(null);
    if (!("MediaRecorder" in window) || !navigator.mediaDevices?.getUserMedia) {
      setMicError("unsupported");
      return;
    }
    if (!selected) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : "audio/webm";
      const rec = new MediaRecorder(stream, { mimeType: mime });
      chunksRef.current = [];
      rec.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      rec.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: mime.split(";")[0] });
        void sendVoice(blob);
        // تنظيف بلا انتظار (الإرسال في الخلفية)
        recorderRef.current?.stream.getTracks().forEach((tk) => tk.stop());
        recorderRef.current = null;
        stopTimer();
      };
      rec.start(400);
      recorderRef.current = rec;
      setRecording(true);
      setRecordSec(0);
      timerRef.current = setInterval(() => setRecordSec((s) => s + 1), 1000);
      autoStopRef.current = setTimeout(() => {
        if (recorderRef.current?.state === "recording") recorderRef.current.stop();
      }, MAX_RECORD_SEC * 1000);
    } catch {
      setMicError("denied");
    }
  }

  function stopRecording(send: boolean) {
    const rec = recorderRef.current;
    if (!rec) return;
    if (!send) {
      rec.onstop = null; // إلغاء بلا إرسال
      rec.stop();
      cleanupRecorder();
      return;
    }
    if (rec.state === "recording") rec.stop();
    setRecording(false); // onstop يكمل
  }

  async function sendVoice(blob: Blob) {
    if (!selected || blob.size === 0) return;
    setSending(true);
    try {
      const durationSec = recordSec;
      const form = new FormData();
      form.set("to", selected.userId);
      form.set("durationSec", String(Math.min(durationSec || 1, MAX_RECORD_SEC)));
      form.set("audio", blob, "voice.webm");
      const res = await fetch("/api/voice-messages", { method: "POST", body: form });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        setMicError(data?.error === "audio_too_large" ? "too_large" : "send_failed");
      } else {
        await loadThread(selected.userId);
      }
    } catch {
      setMicError("send_failed");
    } finally {
      setSending(false);
      setRecordSec(0);
    }
  }

  // ── الكاميرا: صورة/فيديو ──
  async function openCamera(kind: "photo" | "video", facing: "environment" | "user" = camFacing) {
    setDmError(null);
    setCamError(null);
    clearPhotoPreview();
    setVideoPreview((v) => {
      if (v) URL.revokeObjectURL(v.url);
      return null;
    });
    setCamMode(kind);
    setCamOpen(true);
    setCamBusy(true);
    if (!navigator.mediaDevices?.getUserMedia) {
      setCamError("unsupported");
      setCamBusy(false);
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: facing, width: { ideal: 1280 }, height: { ideal: 960 } },
        audio: kind === "video",
      });
      camStreamRef.current = stream;
      if (camVideoRef.current) {
        camVideoRef.current.srcObject = stream;
        await camVideoRef.current.play().catch(() => undefined);
      }
    } catch {
      // الوصول متاح والوسائط موجودة — رفض الحوار = إذن
      setCamError("denied");
    } finally {
      setCamBusy(false);
    }
  }

  function clearPhotoPreview() {
    setPhotoPreview((prev) => {
      if (prev) URL.revokeObjectURL(prev.url);
      return null;
    });
  }

  function closeCamera() {
    stopCamTimers();
    camRecorderRef.current?.stream.getTracks().forEach((tk) => tk.stop());
    camRecorderRef.current = null;
    camStreamRef.current?.getTracks().forEach((tk) => tk.stop());
    camStreamRef.current = null;
    camChunksRef.current = [];
    setCamRecording(false);
    setCamRecordSec(0);
    clearPhotoPreview();
    setVideoPreview((v) => {
      if (v) URL.revokeObjectURL(v.url);
      return null;
    });
    setCamOpen(false);
  }

  function stopCamTimers() {
    if (camTimerRef.current) clearInterval(camTimerRef.current);
    if (camAutoStopRef.current) clearTimeout(camAutoStopRef.current);
    camTimerRef.current = null;
    camAutoStopRef.current = null;
  }

  function capturePhoto() {
    const video = camVideoRef.current;
    if (!video || !video.videoWidth) return;
    // تصغير إلى 1280 ضلعًا أطول — جودة كافية وبحجم ≤ الحد
    const scale = Math.min(1, 1280 / Math.max(video.videoWidth, video.videoHeight));
    const w = Math.round(video.videoWidth * scale);
    const h = Math.round(video.videoHeight * scale);
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    canvas.getContext("2d")?.drawImage(video, 0, 0, w, h);
    // (بلاغ المالك 2026-10-25 — جذر خلل إرسال الصورة): كان toDataURL ثم
    // fetch(dataURL) لاستعادة Blob — وfetch على data: محجوب بسياسة CSP
    // connect-src 'self' https: wss: (خطأ المتصفح: Fetch API cannot load
    // data:image/jpeg) ⇒ الإرسال يفشل دائمًا. الآن: toBlob مباشرة (Blob حقيقي
    // بلا أي fetch)، مع سقوط يدوي إلى فك base64 إن غاب toBlob في بيئة قديمة.
    const toBlob = (): Promise<Blob | null> =>
      new Promise((resolve) => {
        if (typeof canvas.toBlob === "function") {
          canvas.toBlob((b) => resolve(b), "image/jpeg", 0.85);
        } else {
          resolve(dataUrlToBlob(canvas.toDataURL("image/jpeg", 0.85)));
        }
      });
    void toBlob().then((blob) => {
      if (!blob) return;
      setPhotoPreview((prev) => {
        if (prev) URL.revokeObjectURL(prev.url);
        return { url: URL.createObjectURL(blob), blob };
      });
    });
  }

  async function startVideoRecord() {
    const stream = camStreamRef.current;
    if (!stream || !("MediaRecorder" in window)) return;
    const mime = MediaRecorder.isTypeSupported("video/webm;codecs=vp8,opus")
      ? "video/webm;codecs=vp8,opus"
      : MediaRecorder.isTypeSupported("video/webm")
        ? "video/webm"
        : "video/mp4";
    try {
      const rec = new MediaRecorder(stream, { mimeType: mime });
      camChunksRef.current = [];
      rec.ondataavailable = (e) => {
        if (e.data.size > 0) camChunksRef.current.push(e.data);
      };
      rec.onstop = () => {
        const blob = new Blob(camChunksRef.current, { type: mime.split(";")[0] });
        const durationSec = camRecordSec || 1;
        setVideoPreview({ url: URL.createObjectURL(blob), blob, durationSec });
        stopCamTimers();
        setCamRecording(false);
      };
      rec.start(400);
      camRecorderRef.current = rec;
      setCamRecording(true);
      setCamRecordSec(0);
      camTimerRef.current = setInterval(() => setCamRecordSec((s) => s + 1), 1000);
      camAutoStopRef.current = setTimeout(() => {
        if (camRecorderRef.current?.state === "recording") camRecorderRef.current.stop();
      }, MAX_VIDEO_SEC * 1000);
    } catch {
      setCamError("denied");
    }
  }

  function stopVideoRecord() {
    if (camRecorderRef.current?.state === "recording") camRecorderRef.current.stop();
  }

  /** إرسال رسالة مرئية/موقعية (multipart) — تعيين الخطأ وفق شيفرة الخادم */
  async function sendDirect(form: FormData) {
    if (!selected) return false;
    setSending(true);
    setDmError(null);
    try {
      const res = await fetch("/api/direct-messages", { method: "POST", body: form });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        const code = data?.error ?? "";
        setDmError(
          code === "photo_too_large"
            ? "photoTooLarge"
            : code === "video_too_large"
              ? "videoTooLarge"
              : code === "not_image" || code === "not_video"
                ? "sendFailed"
                : "sendFailed",
        );
        return false;
      }
      await loadThread(selected.userId);
      return true;
    } catch {
      setDmError("sendFailed");
      return false;
    } finally {
      setSending(false);
    }
  }

  async function sendPhotoPreview() {
    if (!photoPreview || !selected) return;
    // Blob جاهز من الالتقاط (toBlob) — لا fetch لـdata: إطلاقًا (جذر الخلل السابق)
    const form = new FormData();
    form.set("to", selected.userId);
    form.set("kind", "photo");
    form.set("media", photoPreview.blob, "photo.jpg");
    const url = photoPreview.url;
    if (await sendDirect(form)) {
      URL.revokeObjectURL(url);
      closeCamera();
    }
  }

  async function sendVideoPreview() {
    if (!videoPreview || !selected) return;
    const form = new FormData();
    form.set("to", selected.userId);
    form.set("kind", "video");
    form.set("durationSec", String(videoPreview.durationSec));
    form.set("media", videoPreview.blob, "clip.webm");
    const url = videoPreview.url;
    if (await sendDirect(form)) {
      URL.revokeObjectURL(url);
      closeCamera();
    }
  }

  async function shareLocation() {
    if (!selected || locBusy) return;
    setDmError(null);
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      setDmError("locUnsupported");
      return;
    }
    setLocBusy(true);
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        const form = new FormData();
        form.set("to", selected.userId);
        form.set("kind", "location");
        form.set("lat", String(pos.coords.latitude));
        form.set("lng", String(pos.coords.longitude));
        form.set("accuracyM", String(Math.round(pos.coords.accuracy ?? 0)));
        await sendDirect(form);
        setLocBusy(false);
      },
      () => {
        setDmError("locDenied");
        setLocBusy(false);
      },
      { enableHighAccuracy: true, timeout: 15_000, maximumAge: 5_000 },
    );
  }

  // ── التشغيل والعرض ──
  /** تعليم المشاهدة (المستقبِل فقط — مشاهدة الإشراف لا تعلّمها) — والفيديو
   *  يُستهلك بها: الحمولة تُمسح في الخادم فورًا (بلاغ المالك 2026-10-25) */
  function markViewed(msg: DirectMsg) {
    if (msg.recipientId !== myUserId || msg.viewedAt) return;
    const consumesVideo = msg.kind === "video" && !msg.purgedAt;
    void fetch(`/api/direct-messages/${msg.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ viewed: true }),
    })
      .then((r) => (r.ok ? r.json().catch(() => null) : null))
      .then((data: { purged?: boolean } | null) => {
        const purged = consumesVideo || data?.purged === true;
        setDmMessages((prev) =>
          prev.map((m) =>
            m.id === msg.id
              ? {
                  ...m,
                  viewedAt: m.viewedAt ?? new Date().toISOString(),
                  // الفيديو مُستهلك: الحمولة مُسحت (سيظهر كذلك بعد التحديث)
                  purgedAt: purged ? (m.purgedAt ?? new Date().toISOString()) : m.purgedAt,
                  purgedBy: purged ? (m.purgedBy ?? myUserId) : m.purgedBy,
                }
              : m,
          ),
        );
      })
      .catch(() => null);
  }

  function togglePlay(msg: VoiceMsg) {
    // مُستهلكة: المحتوى مُسح من الخادم — غير قابلة للتشغيل أصلًا
    if (msg.purgedAt) return;
    if (playingId === msg.id) {
      audioRef.current?.pause();
      setPlayingId(null);
      return;
    }
    audioRef.current?.pause();
    const audio = new Audio(`/api/voice-messages/${msg.id}/audio`);
    audioRef.current = audio;
    setPlayingId(msg.id);
    // المستقبِل يعلّمها مستمعًا إليه عند أول تشغيل (استماع المشرف لا يعلّمها)
    if (msg.recipientId === myUserId && !msg.listenedAt) {
      void fetch(`/api/voice-messages/${msg.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ listened: true }),
      })
        .then(() => {
          // الاستماع = استهلاك: المحتوى مُسح في الخادم (سيظهر كذلك بعد التحديث)
          setMessages((prev) =>
            prev.map((m) => (m.id === msg.id ? { ...m, listenedAt: new Date().toISOString(), purgedAt: new Date().toISOString(), purgedBy: myUserId } : m)),
          );
        })
        .catch(() => null);
    } else if (msg.senderId !== myUserId) {
      // المعني بالأمر (إشراف voice.admin يتصفح خيوط/مجموعات غيره): تشغيله استهلاك
      // أيضًا — يمسح المحتوى (بلا تعليم listenedAt للمستقبِل)
      void fetch(`/api/voice-messages/${msg.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ consumed: true }),
      })
        .then(() => {
          setMessages((prev) => prev.map((m) => (m.id === msg.id ? { ...m, purgedAt: new Date().toISOString(), purgedBy: myUserId } : m)));
          setBrowseMessages((prev) => prev.map((m) => (m.id === msg.id ? { ...m, purgedAt: new Date().toISOString(), purgedBy: myUserId } : m)));
        })
        .catch(() => null);
    }
    audio.onended = () => setPlayingId(null);
    audio.onerror = () => setPlayingId(null);
    void audio.play().catch(() => setPlayingId(null));
  }

  useEffect(() => {
    return () => {
      audioRef.current?.pause();
      if (recorderRef.current) cleanupRecorder();
      if (camStreamRef.current) closeCamera();
      realtimeRef.current?.close();
    };
  }, []);

  const fmtTime = (iso: string) =>
    new Date(iso).toLocaleString(locale, {
      dateStyle: "short",
      timeStyle: "short",
      timeZone: "Africa/Casablanca",
    });

  // دمج الرسائل الصوتية والمرئية/الموقعية في مسار واحد زمني — قبل أي عودة
  // مبكرة (قاعدة الـhooks: كل الاستدعاءات بنفس الترتيب في كل عرض)
  const thread = useMemo(() => {
    type Item =
      | { type: "voice"; at: string; msg: VoiceMsg }
      | { type: "dm"; at: string; msg: DirectMsg };
    const items: Item[] = [
      ...messages.map((m) => ({ type: "voice" as const, at: m.createdAt, msg: m })),
      ...dmMessages.map((m) => ({ type: "dm" as const, at: m.createdAt, msg: m })),
    ];
    items.sort((a, b) => a.at.localeCompare(b.at));
    return items;
  }, [messages, dmMessages]);

  const dmErrorText = () => {
    if (!dmError) return null;
    if (dmError === "photoTooLarge") return t("voice.photoTooLarge");
    if (dmError === "videoTooLarge") return t("voice.videoTooLarge");
    if (dmError === "locDenied") return t("voice.locDenied");
    if (dmError === "locUnsupported") return t("voice.locUnsupported");
    return t("voice.sendFailed");
  };

  // ── العرض ──
  if (loading) return <ListState loading error={false} empty={false} />;
  if (error) return <ListState loading={false} error empty={false} onRetry={() => void loadContacts()} />;

  const contactById = new Map(contacts.map((c) => [c.userId, c]));

  return (
    <div className="flex flex-col gap-6">
      {/* شريط الوضع */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <Radio className="size-4 text-primary" aria-hidden />
          {mode === "admin" ? t("voice.modeAdmin") : t("voice.modeTeam")}
          <Badge variant={live ? "secondary" : "outline"} className="gap-1 text-[10px]">
            <span className={`size-1.5 rounded-full ${live ? "bg-emerald-500" : "bg-muted-foreground/50"}`} aria-hidden />
            {live ? t("voice.liveOn") : t("voice.liveFallback")}
          </Badge>
        </div>
        {mode === "admin" && adminGroups.length > 0 && (
          <div className="flex items-center gap-2">
            <ShieldCheck className="size-4 text-primary" aria-hidden />
            <span className="text-xs text-muted-foreground">{t("voice.browseGroup")}</span>
            <Select value={browseGroup} onValueChange={setBrowseGroup}>
              <SelectTrigger className="h-8 w-52 text-xs" aria-label={t("voice.browseGroup")}>
                <SelectValue placeholder={t("voice.noGroupSelected")} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>{t("voice.noGroupSelected")}</SelectItem>
                {adminGroups.map((g) => (
                  <SelectItem key={g.id} value={g.id}>{g.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
      </div>

      {/* تصفح الإشراف لفريق */}
      {mode === "admin" && browseGroup !== NONE && (
        <Card className="border-border/70">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-bold">
              {t("voice.groupFeedTitle")} — {adminGroups.find((g) => g.id === browseGroup)?.name}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {browseMessages.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">{t("voice.noMessages")}</p>
            ) : (
              <ScrollArea className="max-h-96">
                <ul className="divide-y divide-border/60">
                  {browseMessages.map((m) => {
                    const sender = contactById.get(m.senderId)?.fullName ?? m.senderId.slice(0, 8);
                    const recipient = contactById.get(m.recipientId)?.fullName ?? m.recipientId.slice(0, 8);
                    return (
                      <li key={m.id} className="flex items-center justify-between gap-3 px-2 py-2.5 text-sm">
                        <div className="flex min-w-0 flex-col">
                          <span className="truncate">
                            {sender} <span className="text-muted-foreground">→</span> {recipient}
                          </span>
                          <span className="text-[11px] text-muted-foreground tabular-nums" dir="auto">
                            {fmtTime(m.createdAt)} · {hoursLabel(m.durationSec)}
                            {m.purgedAt ? ` · ${t("voice.purgedBadge")}` : ""}
                          </span>
                        </div>
                        {m.purgedAt ? (
                          <span className="flex size-8 shrink-0 items-center justify-center" aria-hidden>
                            <Trash2 className="size-3.5 text-muted-foreground" />
                          </span>
                        ) : (
                          <Button variant="outline" size="sm" className="size-8 shrink-0" onClick={() => togglePlay(m)} aria-label={t("voice.play")}>
                            {playingId === m.id ? <Pause className="size-3.5" aria-hidden /> : <Play className="size-3.5" aria-hidden />}
                          </Button>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </ScrollArea>
            )}
          </CardContent>
        </Card>
      )}

      {/* المحادثات: قائمة + مسار */}
      <div className="grid gap-4 lg:grid-cols-[300px,1fr]">
        {/* جهات الاتصال */}
        <Card className={`border-border/70 ${selected ? "hidden lg:block" : ""}`}>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-sm font-bold">
              <Users className="size-4 text-primary" aria-hidden />
              {mode === "admin" ? t("voice.contactsAll") : t("voice.contactsTeam")}
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {contacts.length === 0 ? (
              <p className="px-4 py-8 text-center text-sm text-muted-foreground">{t("voice.noContacts")}</p>
            ) : (
              <ScrollArea className="max-h-[520px]">
                <ul className="divide-y divide-border/60">
                  {contacts.map((c) => {
                    const unread =
                      (liveUnread[c.userId] ?? 0) +
                      (selected?.userId === c.userId
                        ? messages.filter((m) => m.recipientId === myUserId && m.senderId === c.userId && !m.listenedAt).length
                        : 0);
                    return (
                      <li key={c.userId}>
                        <button
                          type="button"
                          onClick={() => {
                            setSelected(c);
                            setBrowseGroup(NONE);
                          }}
                          className={`flex w-full items-center gap-3 px-4 py-3 text-start transition-colors hover:bg-muted/60 ${
                            selected?.userId === c.userId ? "bg-muted" : ""
                          }`}
                        >
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                              <span className="truncate text-sm font-semibold">{c.fullName}</span>
                              {unread > 0 && <Badge className="h-4 min-w-4 px-1 text-[10px]">{unread}</Badge>}
                            </div>
                            <span className="block truncate text-[11px] text-muted-foreground">
                              {jobTitleLabel(c.jobTitleKey, locale) ?? t("presence.noJobTitle")}
                            </span>
                          </div>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </ScrollArea>
            )}
          </CardContent>
        </Card>

        {/* المحادثة المفتوحة */}
        <Card className={`border-border/70 ${selected ? "" : "hidden lg:flex"} flex flex-col`}>
          {selected ? (
            <>
              <CardHeader className="flex flex-row items-center justify-between gap-2 border-b border-border/60 pb-3">
                <div className="flex items-center gap-2">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-8 lg:hidden"
                    onClick={() => setSelected(null)}
                    aria-label={t("voice.back")}
                  >
                    <BackArrow className="size-4" aria-hidden />
                  </Button>
                  <div className="flex flex-col leading-tight">
                    <span className="text-sm font-bold">{selected.fullName}</span>
                    <span className="text-[11px] text-muted-foreground">
                      {jobTitleLabel(selected.jobTitleKey, locale) ?? t("presence.noJobTitle")}
                    </span>
                  </div>
                </div>
                <div className="flex items-center gap-1">
                  {/* أزرار التواصل المباشر (بلاغ المالك 2026-10-24): اتصال آنٍ صوت/صورة
                      — WebRTC نظير-إلى-نظير: يُستهلك لحظيًا بين الطرفين ولا يُخزّن
                      في المنصة أبدًا (مدير الاتصال في تخطيط اللوحة يتولى الشاشة) */}
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-8 text-emerald-600 hover:text-emerald-700"
                    onClick={() => requestStartCall({ userId: selected.userId, name: selected.fullName, media: "audio" })}
                    aria-label={t("voice.callAudio")}
                    title={t("voice.callAudio")}
                  >
                    <Phone className="size-4" aria-hidden />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-8 text-emerald-600 hover:text-emerald-700"
                    onClick={() => requestStartCall({ userId: selected.userId, name: selected.fullName, media: "video" })}
                    aria-label={t("voice.callVideo")}
                    title={t("voice.callVideo")}
                  >
                    <Video className="size-4" aria-hidden />
                  </Button>
                  <span className="ms-1 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                    <Clock className="size-3.5" aria-hidden />
                    {live ? t("voice.liveOn") : t("voice.liveFallback")}
                  </span>
                </div>
              </CardHeader>
              <CardContent className="flex min-h-[320px] flex-col gap-3 p-4">
                <ScrollArea className="max-h-[380px] flex-1">
                  {threadLoading ? (
                    <div className="flex justify-center py-8">
                      <LoaderCircle className="size-5 animate-spin text-muted-foreground" aria-hidden />
                    </div>
                  ) : thread.length === 0 ? (
                    <p className="py-10 text-center text-sm text-muted-foreground">{t("voice.threadEmpty")}</p>
                  ) : (
                    <ul className="flex flex-col gap-2.5">
                      {thread.map((item) => {
                        const mine = item.type === "voice" ? item.msg.senderId === myUserId : item.msg.senderId === myUserId;
                        const id = item.type === "voice" ? item.msg.id : item.msg.id;
                        return (
                          <li key={`${item.type}-${id}`} className={`flex ${mine ? "justify-end" : "justify-start"}`}>
                            {item.type === "voice" ? (
                              item.msg.purgedAt ? (
                                /* مُستهلكة ومُسحت (متلقٍّ أو معني بالأمر أو انتهاء العمر) */
                                <div
                                  className={`flex max-w-[85%] items-center gap-2.5 rounded-2xl border border-dashed px-3.5 py-2.5 ${
                                    mine ? "border-primary/40 bg-primary/5" : "border-border bg-muted/40"
                                  }`}
                                  aria-label={t("voice.purgedBadge")}
                                >
                                  <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted">
                                    <Trash2 className="size-4 text-muted-foreground" aria-hidden />
                                  </span>
                                  <div className="flex flex-col leading-tight">
                                    <span className="text-xs font-semibold text-muted-foreground">{t("voice.purgedBadge")}</span>
                                    <span className="text-[10px] text-muted-foreground tabular-nums" dir="auto">
                                      {fmtTime(item.msg.createdAt)} · {hoursLabel(item.msg.durationSec)}
                                    </span>
                                  </div>
                                </div>
                              ) : (
                              <div
                                className={`flex max-w-[85%] items-center gap-2.5 rounded-2xl px-3.5 py-2.5 ${
                                  mine ? "bg-primary text-primary-foreground" : "bg-muted text-foreground"
                                }`}
                              >
                                <button
                                  type="button"
                                  onClick={() => togglePlay(item.msg)}
                                  className="flex size-8 shrink-0 items-center justify-center rounded-full bg-black/10"
                                  aria-label={t("voice.play")}
                                >
                                  {playingId === item.msg.id ? (
                                    <Pause className="size-4" aria-hidden />
                                  ) : (
                                    <Play className="size-4" aria-hidden />
                                  )}
                                </button>
                                <div className="flex flex-col leading-tight">
                                  <span className="text-xs font-semibold tabular-nums" dir="ltr">
                                    {hoursLabel(item.msg.durationSec)}
                                  </span>
                                  <span className="text-[10px] opacity-80 tabular-nums" dir="auto">
                                    {fmtTime(item.msg.createdAt)}
                                    {mine && item.msg.listenedAt && (
                                      <span className="ms-1 inline-flex items-center gap-0.5">
                                        <CheckCheck className="size-3" aria-hidden />
                                      </span>
                                    )}
                                  </span>
                                </div>
                              </div>
                              )
                            ) : item.msg.kind === "photo" ? (
                              <button
                                type="button"
                                onClick={() => {
                                  markViewed(item.msg);
                                  setViewer(item.msg);
                                }}
                                className={`block max-w-[85%] overflow-hidden rounded-2xl ${
                                  mine ? "bg-primary" : "bg-muted"
                                }`}
                                aria-label={t("voice.kindPhoto")}
                              >
                                <img
                                  src={`/api/direct-messages/${item.msg.id}/media`}
                                  alt={t("voice.kindPhoto")}
                                  loading="lazy"
                                  className="h-40 w-auto rounded-2xl object-cover"
                                />
                                <span className="flex items-center justify-between gap-2 px-3 py-1.5 text-[10px] tabular-nums" dir="auto">
                                  <span className="inline-flex items-center gap-1">
                                    <ImageIcon className="size-3" aria-hidden />
                                    {t("voice.kindPhoto")}
                                  </span>
                                  <span className="inline-flex items-center gap-0.5 opacity-80">
                                    {fmtTime(item.msg.createdAt)}
                                    {mine && item.msg.viewedAt && <CheckCheck className="size-3" aria-hidden />}
                                  </span>
                                </span>
                              </button>
                            ) : item.msg.kind === "video" ? (
                              item.msg.purgedAt ? (
                                /* فيديو مُستهلك ومُسح (متلقٍّ أو معني بالأمر أو انتهاء العمر) —
                                   نفس شارة الصوتيات المؤقتة (بلاغ المالك 2026-10-25) */
                                <div
                                  className={`flex max-w-[85%] items-center gap-2.5 rounded-2xl border border-dashed px-3.5 py-2.5 ${
                                    mine ? "border-primary/40 bg-primary/5" : "border-border bg-muted/40"
                                  }`}
                                  aria-label={t("voice.purgedBadge")}
                                >
                                  <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted">
                                    <Trash2 className="size-4 text-muted-foreground" aria-hidden />
                                  </span>
                                  <div className="flex flex-col leading-tight">
                                    <span className="text-xs font-semibold text-muted-foreground">{t("voice.purgedBadge")}</span>
                                    <span className="text-[10px] text-muted-foreground tabular-nums" dir="auto">
                                      {fmtTime(item.msg.createdAt)} · {hoursLabel(item.msg.durationSec)}
                                    </span>
                                  </div>
                                </div>
                              ) : (
                              <div className={`max-w-[85%] overflow-hidden rounded-2xl ${mine ? "bg-primary" : "bg-muted"}`}
                                onPointerDown={() => markViewed(item.msg)}
                              >
                                <video
                                  controls
                                  preload="metadata"
                                  src={`/api/direct-messages/${item.msg.id}/media`}
                                  className="h-44 w-auto rounded-t-2xl object-cover"
                                />
                                <span className="flex items-center justify-between gap-2 px-3 py-1.5 text-[10px] tabular-nums" dir="auto">
                                  <span className="inline-flex items-center gap-1">
                                    <Video className="size-3" aria-hidden />
                                    {t("voice.kindVideo")} · {hoursLabel(item.msg.durationSec)}
                                  </span>
                                  <span className="inline-flex items-center gap-0.5 opacity-80">
                                    {fmtTime(item.msg.createdAt)}
                                    {mine && item.msg.viewedAt && <CheckCheck className="size-3" aria-hidden />}
                                  </span>
                                </span>
                              </div>
                              )
                            ) : (
                              <a
                                href={`https://www.openstreetmap.org/?mlat=${item.msg.lat}&mlon=${item.msg.lng}#map=17/${item.msg.lat}/${item.msg.lng}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                onClick={() => markViewed(item.msg)}
                                className={`flex max-w-[85%] items-center gap-3 rounded-2xl px-3.5 py-2.5 ${
                                  mine ? "bg-primary text-primary-foreground" : "bg-muted text-foreground"
                                }`}
              >
                                <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-black/10">
                                  <MapPin className="size-4" aria-hidden />
                                </span>
                                <span className="flex flex-col leading-tight">
                                  <span className="text-xs font-semibold">{t("voice.kindLocation")}</span>
                                  <span className="text-[10px] opacity-80 tabular-nums" dir="ltr">
                                    {item.msg.lat?.toFixed(5)}, {item.msg.lng?.toFixed(5)}
                                    {item.msg.accuracyM != null ? ` · ±${Math.round(item.msg.accuracyM)}m` : ""}
                                  </span>
                                  <span className="text-[10px] opacity-80 tabular-nums" dir="auto">
                                    {fmtTime(item.msg.createdAt)}
                                    {mine && item.msg.viewedAt && (
                                      <span className="ms-1 inline-flex items-center gap-0.5">
                                        <CheckCheck className="size-3" aria-hidden />
                                      </span>
                                    )}
                                  </span>
                                </span>
                              </a>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </ScrollArea>

                {/* شريط الإنشاء: صوت + صورة + فيديو + موقع */}
                <div className="space-y-2 rounded-xl border border-border/60 bg-muted/40 p-3">
                  {(micError || dmErrorText()) && (
                    <span className="block text-xs text-red-600 dark:text-red-400">
                      {micError
                        ? micError === "denied"
                          ? t("voice.micDenied")
                          : micError === "unsupported"
                            ? t("voice.micUnsupported")
                            : micError === "too_large"
                              ? t("voice.tooLarge")
                              : t("voice.sendFailed")
                        : dmErrorText()}
                    </span>
                  )}
                  {recording ? (
                    <div className="flex w-full items-center justify-between gap-3">
                      <div className="flex items-center gap-2 text-sm font-semibold text-red-600 dark:text-red-400">
                        <span className="relative flex size-2.5">
                          <span className="absolute inline-flex size-full animate-ping rounded-full bg-red-400 opacity-75" />
                          <span className="relative inline-flex size-2.5 rounded-full bg-red-500" />
                        </span>
                        {t("voice.recording")} · <span dir="ltr">{hoursLabel(recordSec)}</span> / {hoursLabel(MAX_RECORD_SEC)}
                      </div>
                      <div className="flex items-center gap-2">
                        <Button variant="outline" size="sm" onClick={() => stopRecording(false)} className="gap-2">
                          <Square className="size-3.5" aria-hidden />
                          {t("voice.cancel")}
                        </Button>
                        <Button size="sm" onClick={() => stopRecording(true)} className="gap-2">
                          <Radio className="size-3.5" aria-hidden />
                          {sending ? t("common.saving") : t("voice.send")}
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex flex-wrap items-center gap-2">
                      <Button variant="outline" size="sm" onClick={() => void startRecording()} disabled={sending} className="gap-2">
                        {sending ? (
                          <>
                            <LoaderCircle className="size-4 animate-spin" aria-hidden />
                            {t("voice.sending")}
                          </>
                        ) : (
                          <>
                            <Mic className="size-4 text-primary" aria-hidden />
                            {t("voice.record")}
                          </>
                        )}
                      </Button>
                      <Button variant="outline" size="sm" onClick={() => void openCamera("photo")} disabled={sending} className="gap-2">
                        <Camera className="size-4 text-primary" aria-hidden />
                        {t("voice.takePhoto")}
                      </Button>
                      <Button variant="outline" size="sm" onClick={() => void openCamera("video")} disabled={sending} className="gap-2">
                        <Video className="size-4 text-primary" aria-hidden />
                        {t("voice.recordVideo")}
                      </Button>
                      <Button variant="outline" size="sm" onClick={() => void shareLocation()} disabled={sending || locBusy} className="gap-2">
                        {locBusy ? <LoaderCircle className="size-4 animate-spin" aria-hidden /> : <MapPin className="size-4 text-primary" aria-hidden />}
                        {t("voice.shareLocation")}
                      </Button>
                    </div>
                  )}
                  <span className="block text-[11px] text-muted-foreground">
                    {t("voice.composeHint")} — {t("voice.ephemeralNote")}
                  </span>
                </div>
              </CardContent>
            </>
          ) : (
            <CardContent className="flex flex-1 items-center justify-center p-10">
              <p className="text-sm text-muted-foreground">{t("voice.pickContact")}</p>
            </CardContent>
          )}
        </Card>
      </div>

      {/* حوار الكاميرا الموحّد (صورة/فيديو) */}
      <Dialog open={camOpen} onOpenChange={(o) => (!o ? closeCamera() : setCamOpen(true))}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Camera className="size-4 text-primary" aria-hidden />
              {camMode === "photo" ? t("voice.takePhoto") : t("voice.recordVideo")}
            </DialogTitle>
            <DialogDescription>
              {camMode === "photo" ? t("voice.camPhotoHint") : `${t("voice.camVideoHint")} · ≤ ${MAX_VIDEO_SEC}s`}
            </DialogDescription>
          </DialogHeader>

          {camError ? (
            <div className="space-y-3 py-6 text-center">
              <p className="text-sm text-red-600 dark:text-red-400">
                {camError === "denied" ? t("voice.camDenied") : t("voice.camUnsupported")}
              </p>
              <Button variant="outline" size="sm" onClick={() => closeCamera()} className="gap-2">
                <X className="size-4" aria-hidden />
                {t("voice.close")}
              </Button>
            </div>
          ) : photoPreview ? (
            <div className="space-y-3">
              <img src={photoPreview.url} alt={t("voice.kindPhoto")} className="max-h-[46vh] w-full rounded-xl object-contain" />
              <div className="flex items-center justify-between gap-2">
                <Button variant="outline" size="sm" onClick={() => clearPhotoPreview()} className="gap-2">
                  <RefreshCcw className="size-3.5" aria-hidden />
                  {t("voice.retake")}
                </Button>
                <Button size="sm" onClick={() => void sendPhotoPreview()} disabled={sending} className="gap-2">
                  {sending ? <LoaderCircle className="size-4 animate-spin" aria-hidden /> : <Radio className="size-3.5" aria-hidden />}
                  {t("voice.send")}
                </Button>
              </div>
            </div>
          ) : videoPreview ? (
            <div className="space-y-3">
              <video src={videoPreview.url} controls className="max-h-[46vh] w-full rounded-xl object-contain" />
              <div className="flex items-center justify-between gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    URL.revokeObjectURL(videoPreview.url);
                    setVideoPreview(null);
                  }}
                  className="gap-2"
                >
                  <RefreshCcw className="size-3.5" aria-hidden />
                  {t("voice.retake")}
                </Button>
                <Button size="sm" onClick={() => void sendVideoPreview()} disabled={sending} className="gap-2">
                  {sending ? <LoaderCircle className="size-4 animate-spin" aria-hidden /> : <Radio className="size-3.5" aria-hidden />}
                  {t("voice.send")}
                </Button>
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="relative overflow-hidden rounded-xl bg-black" dir="ltr">
                <video ref={camVideoRef} muted playsInline className="aspect-[4/3] w-full object-cover" />
                {camBusy && (
                  <div className="absolute inset-0 flex items-center justify-center bg-black/40">
                    <LoaderCircle className="size-6 animate-spin text-white" aria-hidden />
                  </div>
                )}
                {camRecording && (
                  <span className="absolute start-3 top-3 inline-flex items-center gap-1.5 rounded-full bg-black/60 px-2.5 py-1 text-xs font-semibold text-white">
                    <span className="relative flex size-2">
                      <span className="absolute inline-flex size-full animate-ping rounded-full bg-red-400 opacity-75" />
                      <span className="relative inline-flex size-2 rounded-full bg-red-500" />
                    </span>
                    <span className="tabular-nums">{hoursLabel(camRecordSec)}</span> / {hoursLabel(MAX_VIDEO_SEC)}
                  </span>
                )}
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      const next = camFacing === "environment" ? "user" : "environment";
                      setCamFacing(next);
                      closeCamera();
                      setTimeout(() => void openCamera(camMode, next), 60);
                    }}
                    className="gap-2"
                  >
                    <RefreshCcw className="size-3.5" aria-hidden />
                    {t("voice.switchCamera")}
                  </Button>
                  {camMode === "photo" ? (
                    <Button variant="outline" size="sm" onClick={capturePhoto} disabled={camBusy} className="gap-2">
                      <Camera className="size-4 text-primary" aria-hidden />
                      {t("voice.capture")}
                    </Button>
                  ) : camRecording ? (
                    <Button size="sm" onClick={stopVideoRecord} className="gap-2">
                      <Square className="size-3.5" aria-hidden />
                      {t("voice.stopVideo")}
                    </Button>
                  ) : (
                    <Button variant="outline" size="sm" onClick={() => void startVideoRecord()} disabled={camBusy} className="gap-2">
                      <Video className="size-4 text-primary" aria-hidden />
                      {t("voice.recordVideo")}
                    </Button>
                  )}
                </div>
                <Button variant="ghost" size="sm" onClick={() => closeCamera()} className="gap-2">
                  <X className="size-4" aria-hidden />
                  {t("voice.close")}
                </Button>
              </div>
              {dmErrorText() && <span className="block text-xs text-red-600 dark:text-red-400">{dmErrorText()}</span>}
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* عارض الصورة بالحجم الكامل */}
      <Dialog open={!!viewer && viewer.kind === "photo"} onOpenChange={(o) => (!o ? setViewer(null) : undefined)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t("voice.kindPhoto")}</DialogTitle>
            <DialogDescription>{viewer ? fmtTime(viewer.createdAt) : ""}</DialogDescription>
          </DialogHeader>
          {viewer && (
            <img
              src={`/api/direct-messages/${viewer.id}/media`}
              alt={t("voice.kindPhoto")}
              className="max-h-[70vh] w-full rounded-xl object-contain"
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

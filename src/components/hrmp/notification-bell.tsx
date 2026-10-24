"use client";

// HRMP — جرس الإشعارات (المرحلة 5 — SPEC §4.1 و§8): استطلاع 20ث/120ث + شارة غير المقروء
// «الفوري» عمليًا: push عبر Web Push عند الضبط (VAPID) + استطلاع خفيف داخل التطبيق قناة ثانية موثوقة
// الطلب حجمه ثابت صغير (فهرس userId,readAt) — لا يثقل SQLite على الهاتف
// (بلاغ المالك 2026-10-25 — صلاحية الإشعارات للهواتف والحواسب والأندرويد):
//  - زر «تفعيل إشعارات الجهاز» ظاهر دائمًا (لا يختفي لغياب VAPID) بحالات واضحة:
//    مدعوم/مفعّل/مرفوض — والطلب يمر بصلاحية notifications.push في الخادم.
//  - داخل تطبيق أندرويد: إشعار نظام أصلي عبر جسر Notify عند وصول جديد والشاشة
//    مخفية (الجسر no-op آمن خارج التطبيق).
import { useCallback, useEffect, useRef, useState } from "react";
import { Bell, BellRing, CheckCheck, LoaderCircle, Volume2, VolumeX } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { useI18n } from "@/i18n/provider";
import { formatDate } from "@/components/hrmp/org-bits";
import { isNativeApp, showNativeNotification } from "@/lib/native-bridge";

type ReplacementPayload = {
  siteName: string;
  localDate: string;
  startLabel: string;
  endLabel: string;
  previousWorkerName?: string;
  shiftId: string;
};

type PayslipApprovedPayload = {
  periodLabel: string;
  refNumber: string;
};

type TeamPresencePayload = {
  memberName: string;
  groupName: string;
  zoneRadiusM: number;
  distanceM: number;
  at: string;
};

type NotificationRow = {
  id: string;
  type: string;
  payload: ReplacementPayload | PayslipApprovedPayload | TeamPresencePayload | null;
  readAt: string | null;
  createdAt: string;
};

const POLL_VISIBLE_MS = 20_000;
const POLL_HIDDEN_MS = 120_000;

type PushState = "unknown" | "unsupported" | "denied" | "granted" | "active";

export function NotificationBell() {
  const { t, locale } = useI18n();
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<NotificationRow[]>([]);
  const [unread, setUnread] = useState(0);
  const [busy, setBusy] = useState(false);
  const [pushState, setPushState] = useState<PushState>("unknown");
  const [pushBusy, setPushBusy] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastUnreadRef = useRef<number>(-1);

  const poll = useCallback(async () => {
    try {
      const res = await fetch("/api/notifications", { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as { unreadCount: number; notifications: NotificationRow[] };
      setRows(data.notifications);
      setUnread(data.unreadCount);
      // (بلاغ المالك 2026-10-25 — تطبيق الأندرويد): وصل جديد والشاشة مخفية؟ إشعار
      // نظام أصلي عبر جسر Notify (no-op آمن خارج التطبيق) — داخل التطبيق نفسه
      // الشارة تكفي والجرس واضح.
      if (lastUnreadRef.current >= 0 && data.unreadCount > lastUnreadRef.current && document.visibilityState === "hidden" && isNativeApp()) {
        void showNativeNotification(t("notifications.title"), t("notifications.pushNativeHint"));
      }
      lastUnreadRef.current = data.unreadCount;
    } catch {
      /* الشبكة مؤقتًا؟ الجولة القادمة تعيد المحاولة */
    }
  }, [t]);

  // استطلاع بمعدّلين: مرئي 20ث / مخفي 120ث — وبلا مؤقتات متزامنة متعددة
  useEffect(() => {
    let cancelled = false;
    const loop = () => {
      if (cancelled) return;
      void poll();
      const delay = document.visibilityState === "visible" ? POLL_VISIBLE_MS : POLL_HIDDEN_MS;
      timerRef.current = setTimeout(loop, delay);
    };
    loop();
    const onVisibility = () => {
      if (document.visibilityState === "visible") void poll();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelled = true;
      if (timerRef.current) clearTimeout(timerRef.current);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [poll]);

  // حالة دفع الجهاز من المتصفح نفسه (إذن الإشعارات) + دعم الخادم (VAPID)
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // داخل تطبيق أندرويد: الإذن على مستوى النظام (POST_NOTIFICATIONS يطلبه
        // الغلاف عند الإقلاع) — حالة «مفعّل» منطقية والاشتراك عبر الجسر لاحقًا
        if (isNativeApp()) {
          if (!cancelled) setPushState("granted");
          return;
        }
        if (typeof Notification === "undefined" || !("serviceWorker" in navigator) || !("PushManager" in window)) {
          if (!cancelled) setPushState("unsupported");
          return;
        }
        const permission = Notification.permission;
        const res = await fetch("/api/devices");
        const data = res.ok ? ((await res.json()) as { vapidPublicKey: string | null }) : { vapidPublicKey: null };
        if (!cancelled) {
          setPushState(permission === "granted" ? (data.vapidPublicKey ? "active" : "granted") : permission === "denied" ? "denied" : "unknown");
        }
      } catch {
        /* يبقى unknown — الزر يظهر ويكشف الحالة عند المحاولة */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function markAllRead() {
    setBusy(true);
    try {
      await fetch("/api/notifications/read", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ all: true }),
      });
      await poll();
    } finally {
      setBusy(false);
    }
  }

  async function enablePush() {
    if (pushBusy) return;
    setPushBusy(true);
    try {
      // 1) إذن الإشعارات (هواتف/حواسب) — الرفض حالة واضحة يعرضها الزر
      let permission: NotificationPermission = "granted";
      if (typeof Notification !== "undefined" && Notification.permission === "default") {
        permission = await Notification.requestPermission();
      } else if (typeof Notification !== "undefined") {
        permission = Notification.permission;
      }
      if (permission === "denied") {
        setPushState("denied");
        return;
      }
      // 2) الاشتراك الفوري إن كان الدفع مهيّأً في الخادم (VAPID) — وإلا فالإذن
      //    مفعّل والإشعارات داخل التطبيق تعمل (الحالة granted تظهر كذلك)
      if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
        setPushState("granted");
        return;
      }
      const res = await fetch("/api/devices");
      const { vapidPublicKey } = (await res.json()) as { vapidPublicKey: string | null };
      if (!vapidPublicKey) {
        setPushState("granted");
        return;
      }
      const reg = await navigator.serviceWorker.register("/sw.js");
      await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
      });
      const json = sub.toJSON();
      const regRes = await fetch("/api/devices", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          endpoint: json.endpoint,
          keys: { p256dh: json.keys?.p256dh ?? "", auth: json.keys?.auth ?? "" },
          userAgent: navigator.userAgent.slice(0, 400),
        }),
      });
      // 403 notifications_forbidden: الصلاحية مسحوبة — الحالة تعود كما كانت
      if (regRes.status === 403) {
        setPushState("granted");
        return;
      }
      if (!regRes.ok) throw new Error("register_failed");
      setPushState("active");
    } catch {
      // فشل الاشتراك لا يُفشل الواجهة — الاستطلاع قناة موثوقة؛ الحالة تبقى كما رخصها المتصفح
      setPushState((s) => (s === "active" ? s : typeof Notification !== "undefined" && Notification.permission === "granted" ? "granted" : s));
    } finally {
      setPushBusy(false);
    }
  }

  function renderBody(n: NotificationRow): string {
    if (n.type === "shift_replacement_assigned" && n.payload) {
      const p = n.payload as ReplacementPayload;
      const line = `${t("notifications.replaceLine1")} «${p.siteName}» ${t("notifications.replaceLine2")} ${p.localDate} ${t("notifications.replaceFrom")} ${p.startLabel} ${t("notifications.replaceTo")} ${p.endLabel}`;
      return p.previousWorkerName
        ? `${line} — ${t("notifications.replaceInsteadOf")} ${p.previousWorkerName}`
        : line;
    }
    if (n.type === "payslip_approved" && n.payload) {
      const p = n.payload as PayslipApprovedPayload;
      return `${t("notifications.payslipLine1")} ${p.periodLabel} — ${t("notifications.payslipLine2")} ${p.refNumber}`;
    }
    if (n.type === "team_member_left_zone" && n.payload) {
      const p = n.payload as TeamPresencePayload;
      return `${t("notifications.presenceLeftLine1")} «${p.memberName}» ${t("notifications.presenceLeftLine2")} «${p.groupName}» — ~${Math.round(p.distanceM)} ${t("notifications.presenceMeters")}`;
    }
    if (n.type === "team_member_entered_zone" && n.payload) {
      const p = n.payload as TeamPresencePayload;
      return `${t("notifications.presenceReturnedLine1")} «${p.memberName}» ${t("notifications.presenceReturnedLine2")} «${p.groupName}»`;
    }
    return t("notifications.unknownType");
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="relative size-9"
          aria-label={`${t("notifications.title")}${unread > 0 ? ` (${unread})` : ""}`}
        >
          {unread > 0 ? (
            <BellRing className="size-4.5 text-primary" aria-hidden />
          ) : (
            <Bell className="size-4.5" aria-hidden />
          )}
          {unread > 0 && (
            <Badge
              className="absolute -end-1 -top-1 h-4 min-w-4 px-1 text-[10px] font-bold"
              aria-hidden
            >
              {unread > 9 ? "9+" : unread}
            </Badge>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-0" dir="auto">
        <div className="flex items-center justify-between gap-2 px-3 py-2.5">
          <span className="text-sm font-semibold">{t("notifications.title")}</span>
          <div className="flex items-center gap-1">
            {/* (بلاغ المالك 2026-10-25): تفعيل إشعارات الجهاز — زر دائم بحالات:
                غير مدعوم (مخفي) · مرفوض (أحمر مع تلميح الإعدادات) · مفعّل (علامة
                خضراء) · نشط (اشتراك دفع حي). كان الزر يظهر فقط عند ضبط VAPID. */}
            {pushState !== "unsupported" && pushState !== "active" && (
              <Button
                variant="ghost"
                size="icon"
                className={`size-7 ${pushState === "denied" ? "text-red-600" : ""}`}
                onClick={() => void enablePush()}
                disabled={pushBusy}
                title={pushState === "denied" ? t("notifications.pushDenied") : t("notifications.enableTitle")}
                aria-label={pushState === "denied" ? t("notifications.pushDenied") : t("notifications.enableTitle")}
              >
                {pushBusy ? (
                  <LoaderCircle className="size-3.5 animate-spin" aria-hidden />
                ) : pushState === "denied" ? (
                  <VolumeX className="size-3.5" aria-hidden />
                ) : pushState === "granted" ? (
                  <CheckCheck className="size-3.5 text-green-600" aria-hidden />
                ) : (
                  <Volume2 className="size-3.5" aria-hidden />
                )}
              </Button>
            )}
            {pushState === "active" && (
              <span
                className="flex size-7 items-center justify-center"
                title={t("notifications.pushGrantedHint")}
                aria-label={t("notifications.pushGranted")}
              >
                <CheckCheck className="size-3.5 text-green-600" aria-hidden />
              </span>
            )}
            {unread > 0 && (
              <Button
                variant="ghost"
                size="icon"
                className="size-7"
                onClick={() => void markAllRead()}
                disabled={busy}
                title={t("notifications.markAllRead")}
                aria-label={t("notifications.markAllRead")}
              >
                {busy ? (
                  <LoaderCircle className="size-3.5 animate-spin" aria-hidden />
                ) : (
                  <CheckCheck className="size-3.5" aria-hidden />
                )}
              </Button>
            )}
          </div>
        </div>
        {/* تلميح الحالة عند الرفض — إرشاد واضح بدل الصمت */}
        {pushState === "denied" && (
          <p className="px-3 pb-2 text-[11px] leading-relaxed text-red-600 dark:text-red-400">
            {t("notifications.pushDenied")}
          </p>
        )}
        {pushState === "unsupported" && (
          <p className="px-3 pb-2 text-[11px] leading-relaxed text-muted-foreground">
            {t("notifications.pushUnsupported")}
          </p>
        )}
        <Separator />
        {rows.length === 0 ? (
          <p className="px-4 py-6 text-center text-sm text-muted-foreground">
            {t("notifications.empty")}
          </p>
        ) : (
          <ScrollArea className="max-h-96">
            <ul className="divide-y divide-border/60">
              {rows.map((n) => (
                <li
                  key={n.id}
                  className={`flex flex-col gap-1 px-3 py-2.5 text-sm ${n.readAt ? "opacity-70" : ""}`}
                >
                  <span className="leading-relaxed">{renderBody(n)}</span>
                  <span className="text-[11px] text-muted-foreground" dir="auto">
                    {formatDate(n.createdAt.slice(0, 10), locale)}
                    {" · "}
                    {new Date(n.createdAt).toLocaleTimeString(locale, {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </span>
                </li>
              ))}
            </ul>
          </ScrollArea>
        )}
      </PopoverContent>
    </Popover>
  );
}

function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  // Uint8Array<ArrayBuffer>: توافق صارم مع BufferSource في TS 5.7+ (applicationServerKey)
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const output = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i += 1) output[i] = raw.charCodeAt(i);
  return output;
}

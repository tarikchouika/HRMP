"use client";

// HRMP — جسر الغلاف الأصلي (تطبيق أندرويد — Capacitor) — بلاغ المالك 2026-10-23
// 1) التنزيل: WebView في أندرويد لا ينفّذ <a download> على روابط blob (لا DownloadListener
//    في الغلاف)، فيبدو «تصدير وتحرير وتحميل الوثائق» معطوبًا في التطبيق. العلاج: كتابة
//    الملف في ذاكرة التطبيق ثم فتح مشاركة النظام (حفظ في التنزيلات · فتح ببرنامج PDF ·
//    إرسال) عبر الإضافات الأصلية (Filesystem + Share).
// 2) الأشرطة: نمط شريط الحالة يتبع ثيم المنصة (داكن/فاتح) بدل الافتراضي الثابت.
//
// الواجهة تُخدَم من رابط بعيد (server.url) فلا تُحزَّم معها حزم @capacitor/* — لذلك
// نستدعي الجسر المنخفض المستوى الذي يحقنه الغلاف في كل صفحة:
// window.Capacitor.nativePromise(plugin, method, options).
// كل شيء داخل try/catch وفحص isNativePlatform — المتصفح العادي على سلوكه المعتاد تمامًا.

type CapacitorGlobal = {
  isNativePlatform?: () => boolean;
  getPlatform?: () => string;
  nativePromise?: (pluginName: string, methodName: string, options?: Record<string, unknown>) => Promise<unknown>;
};

function capacitor(): CapacitorGlobal | undefined {
  return (globalThis as unknown as { Capacitor?: CapacitorGlobal }).Capacitor;
}

/** هل نعمل داخل غلاف التطبيق الأصلي (أندرويد)؟ */
export function isNativeApp(): boolean {
  try {
    const cap = capacitor();
    return typeof cap?.nativePromise === "function" && cap.isNativePlatform?.() === true;
  } catch {
    return false;
  }
}

/** نداء إضافة أصلية عبر الجسر المحقون */
async function callPlugin<T>(plugin: string, method: string, options: Record<string, unknown> = {}): Promise<T> {
  const cap = capacitor();
  if (typeof cap?.nativePromise !== "function") throw new Error("native_bridge_missing");
  return (await cap.nativePromise(plugin, method, options)) as T;
}

/** blob ⇒ base64 (بلا بادئة data:) — الشكل الذي تفهمه إضافة Filesystem */
function toBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result ?? "");
      resolve(result.slice(result.indexOf(",") + 1));
    };
    reader.onerror = () => reject(new Error("file_read_failed"));
    reader.readAsDataURL(blob);
  });
}

/** التنزيل في المتصفح العادي (السلوك المعتاد قبل التغيير) */
export function downloadInBrowser(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** حفظ/مشاركة أصلية — true إن تعامل الغلاف مع الملف فعلًا */
async function shareNative(blob: Blob, fileName: string): Promise<boolean> {
  const safe = fileName.replace(/[^\w.\-]+/g, "_") || "document";
  const data = await toBase64(blob);

  let uri: string | undefined;
  // Cache أولًا (بلا أي إذن ومُصرَّح به في file_paths.xml)، ثم Documents كبديل
  for (const directory of ["CACHE", "DOCUMENTS"]) {
    try {
      const written = await callPlugin<{ uri?: string }>("Filesystem", "writeFile", {
        path: safe,
        data,
        directory,
        recursive: true,
      });
      if (written?.uri) {
        uri = written.uri;
        break;
      }
    } catch {
      /* نجرّب المجلد التالي */
    }
  }
  if (!uri) return false;

  try {
    // مشاركة النظام: حفظ في التنزيلات · فتح ببرنامج PDF · إرسال للتطبيقات
    await callPlugin("Share", "share", { title: safe, files: [uri] });
    return true;
  } catch {
    return false;
  }
}

/**
 * إيصال ملف للمستخدم: مشاركة أصلية داخل التطبيق (حفظ/فتح/إرسال)،
 * وتنزيل عادي في أي متصفح — نقطة استدعاء واحدة في الواجهة.
 */
export async function deliverFile(blob: Blob, fileName: string): Promise<void> {
  if (isNativeApp()) {
    try {
      if (await shareNative(blob, fileName)) return;
    } catch {
      /* سقوط إلى التنزيل المتصفحي */
    }
  }
  downloadInBrowser(blob, fileName);
}

/** مزامنة نمط شريط الحالة مع الثيم (LIGHT = أيقونات داكنة على خلفية فاتحة) */
export async function syncStatusBar(isDark: boolean): Promise<void> {
  if (!isNativeApp()) return;
  try {
    await callPlugin("StatusBar", "setStyle", { style: isDark ? "DARK" : "LIGHT" });
  } catch {
    /* الغلاف بلا إضافة شريط الحالة — لا شيء */
  }
}

/**
 * إشعار نظام أصلي داخل تطبيق أندرويد (بلاغ المالك 2026-10-25 — صلاحية الإشعارات):
 * إضافة Notify في الغلاف تطلبه عبر NotificationManager (قناة hrmp_general) بعد
 * منح POST_NOTIFICATIONS وقت الإقلاع. خارج التطبيق (متصفح هواتف/حواسب) no-op
 * آمن — الإشعارات هناك عبر Web Push القياسي (sw.js + VAPID).
 */
export async function showNativeNotification(title: string, body: string): Promise<void> {
  if (!isNativeApp()) return;
  try {
    await callPlugin("Notify", "show", { title: String(title).slice(0, 200), body: String(body).slice(0, 400) });
  } catch {
    /* الغلاف بإصدار أقدم بلا إضافة Notify — لا شيء (الشارة تكفي) */
  }
}

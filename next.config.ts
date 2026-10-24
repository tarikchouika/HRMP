import type { NextConfig } from "next";


// ─── غلق تبعيات عامل عرض المستندات زمن التشغيل (علاج بلاغ الوثائق 2026-10-19) ───
// العامل (render-worker.cjs) يحمّل خارجيًا: pdfkit (بشجرته) + sharp (وحدة أصلية)
// وsharp (وحدة أصلية). القوائم اليدوية السابقة كانت تنقصها شجرة كاملة
// (linebreak/base64-js/pako/bidi-js…) فانكسر توليد PDF — الحل: حساب الغلقة
// الكاملة من node_modules نفسه عند كل بناء، فلا تعود حزمة تنقص أبدًا.
import { readFileSync } from "node:fs";

function depsOf(name: string): string[] {
  try {
    const pkg = JSON.parse(readFileSync(`node_modules/${name}/package.json`, "utf8"));
    return [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.peerDependencies ?? {})];
  } catch {
    return [];
  }
}

function depClosure(roots: string[]): string[] {
  const seen = new Set<string>();
  const queue = [...roots];
  while (queue.length) {
    const name = queue.shift()!;
    if (seen.has(name)) continue;
    seen.add(name);
    for (const dep of depsOf(name)) if (!seen.has(dep)) queue.push(dep);
  }
  return [...seen];
}

// pdfkit (بشجرته كاملة) + sharp — تُضمّن لغرض /api/reports/**
const WORKER_RUNTIME_PACKAGES = depClosure(["pdfkit", "sharp"])
  .map((name) => `./node_modules/${name}/**`);


const nextConfig: NextConfig = {
  output: "standalone",
  // ⚠️ جذر تتبّع الملفات يجب أن يكون **جذر المستودع** لا جذر «مشروع» أعلى منه:
  // لو وُجد package.json/package-lock.json في مجلد أب (مثل /root) ⇒ اختار Next
  // ذلك الجذر ⇒ صار standalone داخل `.next/standalone/F-W-M-S/` بدل
  // `.next/standalone/` ⇒ سكريبت التشغيل (infra/termux/start-server.sh) لم يجد
  // server.js ⇒ **الخادم المحلي لم يقلع** (بلاغ المالك 2026-10-20).
  // التثبيت الصريح يجعل ناتج البناء ثابتًا مهما كان محيط الجهاز.
  outputFileTracingRoot: __dirname,
  // إجراءات الخادم خلف بوابة عكسية (بلاغ المالك 2026-10-19 «خلل في تغيير لغة الموقع» — الجولة الرابعة):
  // حماية CSRF في Next تقارن ترويسة Origin مع x-forwarded-host ثم Host. بوابة Pages
  // (fwms-dg8.pages.dev) تعيد كتابة Host إلى أصل Vercel، وVercel بدوره يستبدل
  // x-forwarded-host بقيمته هو — فلا يرى التطبيق المضيف العام أبدًا ⇒ كل POST لإجراء
  // خادمي يُرفض بخطأ E80 «Invalid Server Actions request» (500) — ومنه setLocaleAction
  // فلا تتبدل اللغة إطلاقًا عبر البوابة مهما صحّ الكود. allowedOrigins هي الآلية الموثّقة
  // في Next لهذه الحالة بالضبط («reverse proxy in front of your app») — تُقبل هذه المضيفين
  // كأصول صالحة، وتبقى الأصول الأجنبية مرفوضة (الأمان محفوظ).
  // عند إضافة نطاق مخصص للبوابة مستقبلًا: أضفه هنا أيضًا (راجع docs/DEPLOYMENT.md §3.2).
  // ملاحظة: بوابة الهاتف (fwms.tarikc.workers.dev) لا تحتاج إدراجًا — تمرر Host العام كما
  // هو فيتطابق مع Origin أصلًا.
  experimental: {
    serverActions: {
      // (إعادة التسمية 2026-10-24): بوابات المنصة الجديدة hrmp.pages.dev
      // (Cloudflare Pages — تخدم الخادم المرجعي) و hrmp.vercel.app (نشر Vercel
      // باسم المشروع الجديد) تُضاف هنا، والقديمة تبقى حية خلال الانتقال.
      allowedOrigins: ["hrmp.pages.dev", "hrmp.vercel.app", "fwms-dg8.pages.dev"],
    },
  },
  // ترويسات أمنية (SPEC §6 + docs/SECURITY.md — المرحلة 8): HSTS (النفق/الوكيل HTTPS دائمًا)
  // ومنع التأطير والتخمين بنوع المحتوى وسياسة الإحالة الصارمة
  poweredByHeader: false,
  async headers() {
    // سياسة أمن المحتوى (CSP) — فحص أمني 2026-10-19
    // ─────────────────────────────────────────────────────────────────────
    // لماذا CSP ثابتة (لا nonce)؟ نسخة nonce الموثّقة في Next تتطلّب تصييرًا
    // ديناميكيًا لكل صفحة، وهي تكسر: (1) سمات style="" المضمّنة (الواجهة تستعملها
    // كثيرًا) ما لم يُضَف 'unsafe-inline'|style-src (فينهار الـnonce نفسه)،
    // (2) الصفحات الساكنة (القانونية/الدليل) لا تُصيَّر ديناميكيًا ⇒ لا يُحقن
    // nonce في سكربتاتها ⇒ يُحجب السكربت. لذلك: CSP ثابتة تحجب المصادر
    // الخارجية والمحقنات والـbase tag والتأطير وتسريب النماذج، وتترك
    // 'unsafe-inline' للسكربتات المضمّنة التي يولّدها Next/React.
    // ملاحظة: 'unsafe-eval' للتطوير فقط (React يحتاجه في dev) — الإنتاج بلاه.
    const isDev = process.env.NODE_ENV !== "production";
    const csp = [
      "default-src 'self'",
      "base-uri 'self'",
      "object-src 'none'",
      "frame-ancestors 'none'",
      "form-action 'self'",
      `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob: https:",
      "font-src 'self' data:",
      "connect-src 'self' https: wss:",
      "media-src 'self' blob: data:",
      "worker-src 'self' blob:",
      "manifest-src 'self'",
      "upgrade-insecure-requests",
    ].join("; ");
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "same-origin" },
          { key: "X-DNS-Prefetch-Control", value: "off" },
          {
            key: "Strict-Transport-Security",
            value: "max-age=31536000; includeSubDomains",
          },
          { key: "Content-Security-Policy", value: csp },
        ],
      },
    ];
  },
  // حزم خادمية ثقيلة لا تُحزَّم (sharp وحدة أصلية) — react-pdf يُحمَّل عبر createRequire
  serverExternalPackages: ["pdfkit", "sharp"],
  // تتبع ملفات standalone: الحزم المحمّلة ديناميكيًا (createRequire/dynamic import)
  // لا تراها أداة التتبع تلقائيًا — تُضمَّن صراحة مع شجراتها
  outputFileTracingIncludes: {
    // لقطة قاعدة المعاينة (Vercel — docs/DEPLOYMENT.md §2): كل مسار يلمس القاعدة
    // يضمّها في حزمته — على Vercel تُحزَّم الدوال كلٌّ على حدة، فلا يكفي تضمينها
    // لمسار واحد. تُنسخ عند الإقلاع إلى /tmp (src/lib/db.ts). خارج Vercel لا تُستعمل.
    "/": ["./infra/vercel/preview.db"],
    "/login": ["./infra/vercel/preview.db"],
    "/dashboard/**": ["./infra/vercel/preview.db"],
    "/verify/**": ["./infra/vercel/preview.db"],
    "/api/**": ["./infra/vercel/preview.db"],
    "/api/reports/**": [
      // عامل العرض (المترجم .cjs + المصدر .ts) — بدون ضمّه هنا كان الملف غائبًا
      // عن حزمة Vercel فيفشل التوليد بـ render_worker_missing (بلاغ 2026-10-19).
      // docx وqrcode والقواميس الأربع تُضمَّن داخل .cjs المُجمَّع (compile-render-worker).
      "./src/lib/reports/**",
      // شجرة pdfkit + sharp كاملة (محسوبة أعلاه — لا قوائم يدوية بعدها)
      ...WORKER_RUNTIME_PACKAGES,
      "./node_modules/@img/**",
      "./public/fonts/**",
    ],
  },
  // ─── بوابة hrmp.vercel.app: تخدم الخادم المرجعي مباشرة (علاج بلاغ المالك 2026-10-25) ───
  // «لا أستطيع تسجيل الدخول لواجهة المنصة المنشورة في ڤيرسيل» — الجذر المُثبت:
  // نشر Vercel كان يشغّل التطبيق على لقطة SQLite مؤقتة (infra/vercel/preview.db →
  // /tmp لكل نسخة) بكلمات مرور مستقلة عن الإنتاج ⇒ تجزئة اعتمادات موثّقة مرتين
  // (2026-10-22 و2026-10-24) — والمالك لا يعرف كلمة اللقطة. والبنية المعتمدة
  // أصلاً (DEPLOYMENT.md §3.2): كل البوابات العامة تخدم الخادم المرجعي
  // (fwms.tarikc.workers.dev — الهاتف عبر النفق) حيث الإنتاج والوثائق فعليًا.
  // هنا نطبّق نفس المعمارية على نطاق Vercel: إعادة كتابة catch-all قبل كل شيء
  // تحوّل كل مسار إلى الأصل المرجعي — نفس الكود ونفس البيانات ونفس كلمة المرور
  // في كل الروابط (التطبيق/pages.dev/vercel.app)، والوثائق المولّدة عبره تُحفظ
  // في قاعدة الإنتاج فعلًا (لا تضيع في /tmp المؤقتة).
  // ملاحظات تشغيلية:
  //   · HRMP_REFERENCE_ORIGIN يغيّر الأصل دون تغيير كود (افتراضي: بوابة الهاتف).
  //   · HRMP_VERCEL_DIRECT=1 يوقف البوابة ويعيد تشغيل التطبيق محليًا على Vercel
  //     (لقطة المعاينة) — باب مفتوح لاعتماد قاعدة سحابية حقيقية مستقبلًا.
  //   · حد حجم طلب Vercel للدوال 4.5MB: رفع وثائق هوية الباحثين (سقفها 5MB)
  //     الأكبر من الحد يستمر عبر hrmp.pages.dev/التطبيق (حد بوابة Cloudflare أعلى).
  //   · الهاتف يجب أن يسحب نفس إصدار المستودع (البوابة تعكس نسخته).
  async rewrites() {
    if (process.env.VERCEL === "1" && process.env.HRMP_VERCEL_DIRECT !== "1") {
      const referenceOrigin = (
        process.env.HRMP_REFERENCE_ORIGIN || "https://fwms.tarikc.workers.dev"
      ).replace(/\/+$/, "");
      return {
        beforeFiles: [{ source: "/:path*", destination: `${referenceOrigin}/:path*` }],
      };
    }
    return { beforeFiles: [] };
  },
  /* config options here */
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
};

export default nextConfig;

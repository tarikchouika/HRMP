import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { Users, Building2, ScrollText, Calculator } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { getSession } from "@/lib/auth/session";
import { localizedName, localizeRow, localizeNested } from "@/lib/localized-name";
import { getUiLocale } from "@/i18n/ui-locale";
import { db } from "@/lib/db";
import { APP_VERSION } from "@/lib/version";
import { readLocaleCookie, resolveLocale } from "@/i18n/config";
import { getDictionary, tServer } from "@/i18n/get-dictionary";

export async function generateMetadata(): Promise<Metadata> {
  const store = await cookies();
  const dict = getDictionary(resolveLocale(readLocaleCookie(store)));
  return { title: tServer(dict, "dashboard.title") };
}

function formatDateTime(iso: Date, locale: string): string {
  const intl =
    locale === "ar" ? "ar-MA" : locale === "fr" ? "fr-MA" : locale === "es" ? "es-MA" : "en-MA";
  return new Intl.DateTimeFormat(intl, {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: "Africa/Casablanca", // SPEC: العرض بتوقيت الشركة
  }).format(iso);
}

/** (بلاغ المالك 2026-10-25 — خلل سجل أحداث الصفحة الرئيسية): كان العمود يعرض
 *  المفتاح الخام (auth.login…) — نفس عقد سجل التدقيق الكامل: الترجمة من
 *  audit.actions بالمفتاح المفكوك على الشرطة السفلية، وسقوط آمن للمفتاح
 *  الخام للقيم غير المفهرسة بعد. */
function auditActionLabel(dict: ReturnType<typeof getDictionary>, action: string): string {
  const key = `audit.actions.${action.replace(/\./g, "_")}`;
  const translated = tServer(dict, key);
  return translated === key ? action : translated;
}

export default async function DashboardPage() {
  const session = await getSession();
  if (!session) redirect("/login");

  const cookieStore = await cookies();
  const locale = resolveLocale(readLocaleCookie(cookieStore));
  const dict = getDictionary(locale);
  // (بلاغ «خلل الترجمة» 2026-10-19): الاستيفاء صار داخل القاموس — لا فاصلة عربية مثبتة
  const t = (key: string, params?: Record<string, string | number>) => tServer(dict, key, params);

  const isSuper = session.role === "super_admin";
  const isCompanyScoped = !isSuper;

  // إحصاءات مقيدة بعزل الشركات (SPEC §3.1): غير المالك يرى شركته فقط
  const [usersCount, companiesCount, auditCount, payRulesCount, recentAudit] = await Promise.all([
    db.userMembership.count({
      where: isCompanyScoped
        ? { companyId: session.companyId, revokedAt: null }
        : { revokedAt: null },
    }),
    isSuper ? db.company.count({ where: { status: "active" } }) : Promise.resolve(1),
    db.auditLog.count({ where: isCompanyScoped ? { companyId: session.companyId } : {} }),
    db.payRule.count({ where: isCompanyScoped ? { OR: [{ companyId: session.companyId }, { companyId: null }] } : {} }),
    db.auditLog.findMany({
      where: isCompanyScoped ? { companyId: session.companyId } : {},
      orderBy: { createdAt: "desc" },
      take: 8,
      include: { user: { select: { fullName: true } }, company: { select: { legalName: true, names: true } } },
    }),
  ]);

  const stats = [
    { labelKey: "dashboard.cardsUsersTitle", value: usersCount, icon: Users },
    { labelKey: "dashboard.cardsCompaniesTitle", value: companiesCount, icon: Building2, superOnly: true },
    { labelKey: "dashboard.cardsAuditTitle", value: auditCount, icon: ScrollText },
    { labelKey: "dashboard.cardsPayRulesTitle", value: payRulesCount, icon: Calculator },
  ].filter((s) => !s.superOnly || isSuper);

  const roleBadgeKey = {
    super_admin: "dashboard.roleSuperAdmin",
    accountant: "dashboard.roleAccountant",
    admin: "dashboard.roleAdmin",
    co_admin: "dashboard.roleCoAdmin",
    employee: "dashboard.roleEmployee",
  }[session.role] ?? "dashboard.roleEmployee";

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6">
      {/* الترحيب */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">
            {/* نص التحية من القاموس بالكامل (أهلاً، {name} / Bonjour, {name}) —
                الفاصلة كانت «،» عربية مثبتة لكل اللغات */}
            {t("dashboard.welcomeWithName", { name: session.name })}
          </h1>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
            {/* كل (وسم + قيمة) في مجموعة واحدة حتى تنزاح ككتلة متماسكة على الجوال */}
            <span className="inline-flex min-w-0 items-center gap-2">
              <span className="shrink-0">{t("dashboard.activeCompany")}:</span>
              <span className="min-w-0 break-words font-semibold text-foreground">{session.companyName}</span>
            </span>
            <span aria-hidden className="hidden sm:inline">·</span>
            <span className="inline-flex items-center gap-2">
              <span className="shrink-0">{t("dashboard.currentRole")}:</span>
              <Badge variant="secondary" className="shrink-0 font-semibold">{t(roleBadgeKey)}</Badge>
            </span>
          </div>
        </div>
      </div>

      {/* الإحصاءات — الجوال: عمودان (كانا عمودًا واحدًا يلتهم الشاشة) — سطح المكتب: أربعة */}
      <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        {stats.map((s) => (
          <Card key={s.labelKey} className="hrmp-card-hover border-border/70">
            <CardContent className="flex items-center justify-between gap-2 p-4 sm:gap-3 sm:p-5">
              <div className="flex min-w-0 flex-col">
                <span className="text-2xl font-extrabold tabular-nums text-foreground" dir="ltr">
                  {s.value}
                </span>
                <span className="mt-0.5 break-words text-xs font-medium text-muted-foreground">{t(s.labelKey)}</span>
              </div>
              <div className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-secondary text-primary">
                <s.icon className="size-5" aria-hidden />
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* أحدث أحداث التدقيق */}
      <Card className="border-border/70">
        <CardHeader className="flex flex-row items-center justify-between pb-2">
          <CardTitle className="flex items-center gap-2 text-base font-bold">
            <ScrollText className="size-4 text-primary" aria-hidden />
            {t("dashboard.recentAudit")}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {recentAudit.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">{t("dashboard.noAuditYet")}</p>
          ) : (
            <div className="max-h-80 overflow-y-auto rounded-lg border border-border/60">
              <Table>
                <TableHeader className="sticky top-0 bg-muted/95 backdrop-blur">
                  <TableRow>
                    <TableHead className="text-xs">{t("dashboard.auditTime")}</TableHead>
                    <TableHead className="text-xs">{t("dashboard.auditAction")}</TableHead>
                    <TableHead className="text-xs">{t("dashboard.auditActor")}</TableHead>
                    {isSuper && <TableHead className="text-xs">{t("dashboard.companies")}</TableHead>}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {recentAudit.map((log) => (
                    <TableRow key={log.id}>
                      <TableCell className="whitespace-nowrap text-xs text-muted-foreground tabular-nums">
                        {formatDateTime(log.createdAt, locale)}
                      </TableCell>
                      <TableCell>
                        <span
                          className="rounded bg-muted px-1.5 py-0.5 text-xs font-medium"
                          dir="auto"
                          title={log.action}
                        >
                          {auditActionLabel(dict, log.action)}
                        </span>
                      </TableCell>
                      <TableCell className="text-xs">{log.user?.fullName ?? "system"}</TableCell>
                      {isSuper && (
                        <TableCell className="max-w-40 truncate text-xs text-muted-foreground">
                          {log.company ? localizedName(log.company, locale, "legalName") : "—"}
                        </TableCell>
                      )}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

    </div>
  );
}

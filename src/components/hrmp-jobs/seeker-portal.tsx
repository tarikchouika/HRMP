"use client";

// HRMP — بوابة الباحث عن عمل (/jobs/me): حالة الحساب + قائمة اكتمال الملف + الطلبات
// مع سحب الطلب وإعادة توجيه غير المسجلين إلى الدخول. الحالات الوسيطة تُظهر روابط
// إكمال الخطوة الناقصة (توثيق/وثيقة) — نفس عناوين معالج التسجيل.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import {
  BadgeCheck,
  Briefcase,
  CheckCircle2,
  Circle,
  LoaderCircle,
  LogOut,
  Mail,
  Send,
  Smartphone,
  XCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { useI18n } from "@/i18n/provider";
import { formatDate } from "@/components/hrmp/org-bits";
import { cn } from "@/lib/utils";

type SeekerProfile = {
  id: string;
  fullName: string;
  email: string;
  phone: string;
  status: string;
  emailVerified: boolean;
  phoneVerified: boolean;
  telegramLinked: boolean;
  telegramVerified: boolean;
  telegramUsername: string | null;
  hasDocument: boolean;
  documentType: string | null;
  documentName: string | null;
  rejectionReason: string | null;
  createdAt: string;
};

type MyApplication = {
  id: string;
  status: string;
  createdAt: string;
  coverNote: string | null;
  vacancy: { id: string; title: string; company: string; closed: boolean };
};

const STATUS_BADGE: Record<string, string> = {
  submitted: "secondary",
  viewed: "secondary",
  shortlisted: "default",
  hired: "default",
  rejected: "destructive",
  withdrawn: "outline",
};

export function SeekerPortal() {
  const { t, locale } = useI18n();
  const router = useRouter();
  const [profile, setProfile] = useState<SeekerProfile | null>(null);
  const [applications, setApplications] = useState<MyApplication[]>([]);
  const [loading, setLoading] = useState(true);
  const [unauthenticated, setUnauthenticated] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/jobs/seeker/me", { cache: "no-store" });
      if (res.status === 401) {
        setUnauthenticated(true);
        return;
      }
      if (res.ok) {
        const data = (await res.json()) as { seeker: SeekerProfile; applications: MyApplication[] };
        setProfile(data.seeker);
        setApplications(data.applications);
      }
    } catch {
      /* شبكة — تبقى حالة التحميل */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (unauthenticated) router.replace("/jobs/login");
  }, [unauthenticated, router]);

  async function logout() {
    await fetch("/api/jobs/seeker/logout", { method: "POST" }).catch(() => null);
    router.replace("/jobs");
    router.refresh();
  }

  async function withdraw(id: string) {
    const res = await fetch(`/api/jobs/applications/${id}/withdraw`, { method: "POST" });
    if (res.ok) {
      void load();
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24">
        <LoaderCircle className="size-6 animate-spin text-muted-foreground" aria-hidden />
      </div>
    );
  }
  if (!profile) return null;

  const checks = [
    { done: profile.emailVerified, label: t("jobs.me.checkEmail"), href: "/jobs/register", Icon: Mail },
    {
      done: profile.phoneVerified || profile.telegramVerified,
      label: t("jobs.me.checkPhone"),
      href: "/jobs/register",
      Icon: profile.telegramVerified ? Send : Smartphone,
    },
    { done: profile.hasDocument, label: t("jobs.me.checkDoc"), href: "/jobs/register", Icon: BadgeCheck },
    { done: profile.status === "approved", label: t("jobs.me.checkAdmin"), href: null, Icon: CheckCircle2 },
  ];
  const incomplete = checks.filter((c) => !c.done);

  return (
    <div className="mx-auto max-w-3xl space-y-6 pt-6">
      {/* الترويسة */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-extrabold tracking-tight">{t("jobs.me.title")}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("jobs.me.welcome", { name: profile.fullName })}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button asChild variant="outline" size="sm" className="gap-2 font-medium">
            <Link href="/jobs">
              <Briefcase className="size-4" aria-hidden />
              {t("jobs.me.browseCta")}
            </Link>
          </Button>
          <Button variant="ghost" size="sm" className="gap-2 font-medium" onClick={() => void logout()}>
            <LogOut className="size-4 rtl:-scale-x-100" aria-hidden />
            {t("jobs.me.logout")}
          </Button>
        </div>
      </div>

      {/* حالة الحساب */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center justify-between gap-2 text-base">
            {t("jobs.me.accountStatus")}
            <Badge
              variant={profile.status === "approved" ? "default" : profile.status === "rejected" ? "destructive" : "secondary"}
              className="gap-1"
            >
              {profile.status === "approved" && <CheckCircle2 className="size-3" aria-hidden />}
              {profile.status === "rejected" && <XCircle className="size-3" aria-hidden />}
              {t(`jobs.me.status.${profile.status}`)}
            </Badge>
          </CardTitle>
          {profile.status === "rejected" && profile.rejectionReason && (
            <CardDescription className="font-medium text-destructive">
              {t("jobs.me.rejectionReason", { reason: profile.rejectionReason })}
            </CardDescription>
          )}
        </CardHeader>
        <Separator />
        <CardContent className="space-y-4 pt-4">
          <div className="grid gap-2 text-sm sm:grid-cols-2">
            <p className="flex items-center gap-2 text-muted-foreground" dir="ltr">
              <Mail className="size-3.5 shrink-0 text-primary" aria-hidden />
              {profile.email}
            </p>
            <p className="flex items-center gap-2 text-muted-foreground" dir="ltr">
              <Smartphone className="size-3.5 shrink-0 text-primary" aria-hidden />
              {profile.phone}
            </p>
            {profile.telegramUsername && (
              <p className="flex items-center gap-2 text-muted-foreground" dir="ltr">
                <Send className="size-3.5 shrink-0 text-primary" aria-hidden />@{profile.telegramUsername}
              </p>
            )}
          </div>
          <div>
            <p className="mb-2 text-sm font-semibold">{t("jobs.me.checklist")}</p>
            <ul className="grid gap-2 sm:grid-cols-2">
              {checks.map((c) => (
                <li
                  key={c.label}
                  className={cn(
                    "flex items-center gap-2 rounded-lg border px-3 py-2 text-sm",
                    c.done ? "border-primary/35 bg-primary/10 text-foreground" : "border-border/70 text-muted-foreground"
                  )}
                >
                  {c.done ? (
                    <CheckCircle2 className="size-4 shrink-0 text-primary" aria-hidden />
                  ) : (
                    <Circle className="size-4 shrink-0" aria-hidden />
                  )}
                  <span className="flex-1">{c.label}</span>
                  {!c.done && c.href && (
                    <Link href={c.href} className="text-xs font-semibold text-primary underline-offset-4 hover:underline">
                      {t("jobs.me.completeProfile").replace(/:$/, "")}
                    </Link>
                  )}
                </li>
              ))}
            </ul>
          </div>
          {incomplete.length > 0 && (
            <p className="text-sm font-medium text-muted-foreground">{t("jobs.me.completeProfile")}</p>
          )}
        </CardContent>
      </Card>

      {/* الطلبات */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("jobs.me.myApplications")}</CardTitle>
        </CardHeader>
        <Separator />
        <CardContent className="pt-4">
          {applications.length === 0 ? (
            <div className="flex flex-col items-center gap-3 py-8 text-center">
              <Briefcase className="size-8 text-muted-foreground/60" aria-hidden />
              <p className="text-sm text-muted-foreground">{t("jobs.me.noApplications")}</p>
              <Button asChild variant="outline" size="sm">
                <Link href="/jobs">{t("jobs.me.browseCta")}</Link>
              </Button>
            </div>
          ) : (
            <ul className="space-y-3">
              {applications.map((a) => (
                <li key={a.id} className="rounded-lg border border-border/70 p-4">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <Link
                        href={`/jobs/${a.vacancy.id}`}
                        className="font-bold text-foreground underline-offset-4 hover:underline"
                      >
                        {a.vacancy.title}
                      </Link>
                      <p className="mt-0.5 text-sm text-muted-foreground">{a.vacancy.company}</p>
                      <p className="mt-1 text-xs text-muted-foreground/80">
                        {t("jobs.me.appliedOn", { date: formatDate(a.createdAt.slice(0, 10), locale) })}
                      </p>
                    </div>
                    <Badge variant={(STATUS_BADGE[a.status] ?? "secondary") as "secondary" | "default" | "destructive" | "outline"}>
                      {t(`jobs.me.applicationStatus.${a.status}`)}
                    </Badge>
                  </div>
                  {a.coverNote && (
                    <p className="mt-2 whitespace-pre-line rounded-md bg-secondary/50 p-2.5 text-sm leading-relaxed text-muted-foreground">
                      {a.coverNote}
                    </p>
                  )}
                  {a.status !== "withdrawn" && a.status !== "hired" && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="mt-2 h-7 px-2 text-xs text-muted-foreground"
                      onClick={() => void withdraw(a.id)}
                    >
                      {t("jobs.withdrawCta")}
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

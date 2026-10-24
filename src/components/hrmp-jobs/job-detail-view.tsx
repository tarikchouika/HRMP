"use client";

// HRMP — تفاصيل وظيفة شاغرة عامة + صندوق التقديم (طلب المالك 2026-10-24):
// الزائر بلا جلسة باحث → دعوة دخول/تسجيل؛ الباحث الموثق المعتمد → زر تقديم
// فعلي؛ وكل الحالات الوسيطة (لم يوثّق/لم يرفع وثيقة/بانتظار المصادقة) تُعرض
// صراحة كي يعرف الباحث خطوته التالية — لا أزرار صامتة تفشل غامضةً.
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Banknote,
  Building2,
  CalendarClock,
  CheckCircle2,
  Clock,
  FolderKanban,
  LoaderCircle,
  LogIn,
  Mail,
  MapPin,
  Phone,
  ShieldCheck,
  UserPlus,
  Users,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { useToast } from "@/hooks/use-toast";
import { useI18n } from "@/i18n/provider";
import { formatMoney } from "@/lib/money";
import { formatDate } from "@/components/hrmp/org-bits";
import type { PublicVacancy } from "@/lib/recruitment/service";

type SeekerMe = {
  seeker: {
    status: string;
    emailVerified: boolean;
    phoneVerified: boolean;
    telegramVerified: boolean;
    hasDocument: boolean;
  };
  applications: { vacancy: { id: string }; status: string }[];
};

function jobError(t: (k: string, p?: Record<string, string | number>) => string, code: string): string {
  const map: Record<string, string> = {
    unauthenticated: "jobs.errors.unauthenticated",
    not_approved: "jobs.errors.not_approved",
    email_unverified: "jobs.errors.email_unverified",
    phone_unverified: "jobs.errors.phone_unverified",
    document_missing: "jobs.errors.document_missing",
    already_applied: "jobs.errors.already_applied",
    vacancy_closed: "jobs.errors.vacancy_closed",
    vacancy_not_found: "jobs.errors.vacancy_not_found",
    internal_error: "jobs.errors.internal_error",
  };
  const key = map[code] ?? "jobs.errors.internal_error";
  return t(key);
}

export function JobDetailView({ vacancy }: { vacancy: PublicVacancy }) {
  const { t, locale, dir } = useI18n();
  const { toast } = useToast();
  const ForwardArrow = dir === "rtl" ? ArrowLeft : ArrowRight;

  const [me, setMe] = useState<SeekerMe | null>(null);
  const [meChecked, setMeChecked] = useState(false);
  const [applying, setApplying] = useState(false);
  const [applied, setApplied] = useState(false);

  const loadMe = useCallback(async () => {
    try {
      const res = await fetch("/api/jobs/seeker/me", { cache: "no-store" });
      if (res.ok) {
        const data = (await res.json()) as SeekerMe;
        setMe(data);
        setApplied(data.applications.some((a) => a.vacancy.id === vacancy.id));
      }
    } catch {
      /* زائر بلا جلسة — الحالة الافتراضية */
    } finally {
      setMeChecked(true);
    }
  }, [vacancy.id]);

  useEffect(() => {
    void loadMe();
  }, [loadMe]);

  async function apply() {
    setApplying(true);
    try {
      const res = await fetch("/api/jobs/apply", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ vacancyId: vacancy.id }),
      });
      const data = (await res.json().catch(() => null)) as { error?: string } | null;
      if (res.ok) {
        setApplied(true);
        toast({ description: t("jobs.appliedOk") });
      } else {
        toast({ variant: "destructive", description: jobError(t, data?.error ?? "internal_error") });
      }
    } catch {
      toast({ variant: "destructive", description: t("jobs.errors.internal_error") });
    } finally {
      setApplying(false);
    }
  }

  const seeker = me?.seeker;
  const hasSecondFactor = !!seeker && (seeker.phoneVerified || seeker.telegramVerified);
  const canApply =
    seeker?.status === "approved" && seeker.emailVerified && hasSecondFactor && seeker.hasDocument;
  const gateHint = !seeker
    ? null
    : !seeker.emailVerified
      ? t("jobs.me.verifyEmail")
      : !hasSecondFactor
        ? t("jobs.me.verifyPhone")
        : !seeker.hasDocument
          ? t("jobs.me.uploadDoc")
          : seeker.status !== "approved"
            ? t("jobs.me.status.pending")
            : null;

  return (
    <div className="mx-auto max-w-4xl space-y-6 pt-6">
      <Button asChild variant="ghost" size="sm" className="-start-2 gap-2 font-medium">
        <Link href="/jobs">
          {dir === "rtl" ? <ArrowRight className="size-4" aria-hidden /> : <ArrowLeft className="size-4" aria-hidden />}
          {t("jobs.backToList")}
        </Link>
      </Button>

      <Card>
        <CardHeader className="space-y-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0 space-y-2">
              <h1 className="text-balance text-2xl font-extrabold leading-snug tracking-tight sm:text-3xl">
                {vacancy.title}
              </h1>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-sm text-muted-foreground">
                <span className="flex items-center gap-1.5">
                  <Building2 className="size-3.5 text-primary" aria-hidden />
                  {vacancy.companyName}
                </span>
                <span className="flex items-center gap-1.5">
                  <FolderKanban className="size-3.5 text-primary" aria-hidden />
                  {vacancy.projectName}
                </span>
                {vacancy.branchCity && (
                  <span className="flex items-center gap-1.5">
                    <MapPin className="size-3.5 text-primary" aria-hidden />
                    {vacancy.branchCity}
                  </span>
                )}
              </div>
            </div>
            <Badge variant="secondary" className="shrink-0">
              {t(`jobs.employmentType.${vacancy.employmentType}`)}
            </Badge>
          </div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <Users className="size-3.5" aria-hidden />
              {vacancy.openings === 1
                ? t("jobs.openingsOne")
                : t("jobs.openingsMany", { count: vacancy.openings })}
            </span>
            <span className="flex items-center gap-1.5">
              <CalendarClock className="size-3.5" aria-hidden />
              {t("jobs.publishedOn", { date: formatDate(vacancy.publishedAt.slice(0, 10), locale) })}
            </span>
            {vacancy.closesAt && (
              <span className="flex items-center gap-1.5 font-semibold text-destructive">
                <Clock className="size-3.5" aria-hidden />
                {t("jobs.applyBefore", { date: formatDate(vacancy.closesAt.slice(0, 10), locale) })}
              </span>
            )}
            {(vacancy.salaryMin != null || vacancy.salaryMax != null) && (
              <span className="flex items-center gap-1.5 font-semibold text-primary" dir="ltr">
                <Banknote className="size-3.5" aria-hidden />
                {vacancy.salaryMin != null && vacancy.salaryMax != null
                  ? `${formatMoney(vacancy.salaryMin, locale)} — ${formatMoney(vacancy.salaryMax, locale)}`
                  : formatMoney(vacancy.salaryMin ?? vacancy.salaryMax!, locale)}
              </span>
            )}
          </div>
        </CardHeader>
        <Separator />
        <CardContent className="space-y-5">
          <section className="space-y-2">
            <h2 className="text-base font-bold">{t("jobs.descriptionTitle")}</h2>
            <p className="whitespace-pre-line text-sm leading-relaxed text-muted-foreground">
              {vacancy.description}
            </p>
          </section>
          {vacancy.requirements && (
            <section className="space-y-2">
              <h2 className="text-base font-bold">{t("jobs.requirementsTitle")}</h2>
              <p className="whitespace-pre-line text-sm leading-relaxed text-muted-foreground">
                {vacancy.requirements}
              </p>
            </section>
          )}
          {(vacancy.contactEmail || vacancy.contactPhone) && (
            <section className="space-y-2">
              <h2 className="text-base font-bold">{t("jobs.contact")}</h2>
              <div className="flex flex-wrap gap-x-6 gap-y-1.5 text-sm">
                {vacancy.contactEmail && (
                  <a
                    href={`mailto:${vacancy.contactEmail}`}
                    className="flex items-center gap-1.5 text-primary underline-offset-4 hover:underline"
                    dir="ltr"
                  >
                    <Mail className="size-3.5" aria-hidden />
                    {vacancy.contactEmail}
                  </a>
                )}
                {vacancy.contactPhone && (
                  <a
                    href={`tel:${vacancy.contactPhone.replace(/\s/g, "")}`}
                    className="flex items-center gap-1.5 text-primary underline-offset-4 hover:underline"
                    dir="ltr"
                  >
                    <Phone className="size-3.5" aria-hidden />
                    {vacancy.contactPhone}
                  </a>
                )}
              </div>
            </section>
          )}
        </CardContent>
      </Card>

      {/* صندوق التقديم */}
      <Card className="border-primary/25 bg-secondary/30">
        <CardContent className="space-y-3 p-5">
          {!meChecked ? (
            <div className="flex items-center justify-center py-2">
              <LoaderCircle className="size-5 animate-spin text-muted-foreground" aria-hidden />
            </div>
          ) : applied ? (
            <div className="flex flex-col items-center gap-2 py-2 text-center">
              <CheckCircle2 className="size-8 text-primary" aria-hidden />
              <p className="text-sm font-semibold text-foreground">{t("jobs.appliedOk")}</p>
              <Button asChild variant="outline" size="sm">
                <Link href="/jobs/me">{t("jobs.me.myApplications")}</Link>
              </Button>
            </div>
          ) : !me ? (
            <div className="flex flex-col items-center gap-3 py-1 text-center">
              <p className="max-w-xl text-sm leading-relaxed text-muted-foreground">
                {t("jobs.applyNeedAccount")}
              </p>
              <div className="flex flex-wrap items-center justify-center gap-2">
                <Button asChild size="sm" className="gap-2 font-semibold">
                  <Link href="/jobs/register">
                    <UserPlus className="size-4" aria-hidden />
                    {t("jobs.applyRegister")}
                  </Link>
                </Button>
                <Button asChild variant="outline" size="sm" className="gap-2 font-medium">
                  <Link href="/jobs/login">
                    <LogIn className="size-4" aria-hidden />
                    {t("jobs.applyLogin")}
                  </Link>
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex flex-col items-center gap-3 py-1 text-center">
              {canApply ? (
                <>
                  <p className="flex items-center gap-2 text-sm font-semibold text-primary">
                    <ShieldCheck className="size-4" aria-hidden />
                    {t("jobs.me.status.approved")}
                  </p>
                  <Button
                    size="lg"
                    className="gap-2 font-bold"
                    onClick={apply}
                    disabled={applying}
                  >
                    {applying ? <LoaderCircle className="size-4 animate-spin" aria-hidden /> : <CheckCircle2 className="size-4" aria-hidden />}
                    {t("jobs.applyCta")}
                    <ForwardArrow className="size-4" aria-hidden />
                  </Button>
                </>
              ) : (
                <>
                  <p className="max-w-xl text-sm font-medium text-muted-foreground">{gateHint}</p>
                  <Button asChild variant="outline" size="sm">
                    <Link href="/jobs/me">{t("jobs.me.completeProfile")}</Link>
                  </Button>
                </>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

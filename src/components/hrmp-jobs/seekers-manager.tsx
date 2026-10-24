"use client";

// HRMP — مدير مصادقة الباحثين عن عمل (أمر المالك 2026-10-24): قائمة مراجعة بحالات
// وفلاتر وبحث، معاينة وثيقة الهوية (Blob URL يُنظَّف بعد الإغلاق — لا كاش عام)،
// اعتماد/رفض بسبب إلزامي. الحساب لا يُعتَمد قبل اكتمال التحقيق الآلي والوثيقة.
import { useCallback, useEffect, useState } from "react";
import {
  BadgeCheck,
  CheckCircle2,
  FileImage,
  LoaderCircle,
  Mail,
  RefreshCcw,
  Search,
  Send,
  Smartphone,
  UserRoundX,
  XCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { useI18n } from "@/i18n/provider";
import { PageHeader, ListState, formatDate, apiRequest } from "@/components/hrmp/org-bits";
import { cn } from "@/lib/utils";

type SeekerRow = {
  id: string;
  fullName: string;
  email: string;
  phone: string;
  status: string;
  emailVerified: boolean;
  phoneVerified: boolean;
  telegramVerified: boolean;
  telegramUsername: string | null;
  hasDocument: boolean;
  documentType: string | null;
  documentName: string | null;
  rejectionReason: string | null;
  reviewedAt: string | null;
  createdAt: string;
  hasApplications: boolean;
};

const STATUS_TABS = ["all", "pending", "approved", "rejected"] as const;

const STATUS_VARIANT: Record<string, "secondary" | "default" | "destructive"> = {
  pending: "secondary",
  approved: "default",
  rejected: "destructive",
};

export function SeekersManager() {
  const { t, locale } = useI18n();
  const { toast } = useToast();

  const [rows, setRows] = useState<SeekerRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [tab, setTab] = useState<(typeof STATUS_TABS)[number]>("pending");
  const [q, setQ] = useState("");

  const [docUrl, setDocUrl] = useState<string | null>(null);
  const [docSeeker, setDocSeeker] = useState<SeekerRow | null>(null);
  const [docLoading, setDocLoading] = useState(false);

  const [rejectFor, setRejectFor] = useState<SeekerRow | null>(null);
  const [rejectReason, setRejectReason] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const params = new URLSearchParams();
      if (tab !== "all") params.set("status", tab);
      if (q.trim()) params.set("q", q.trim());
      const data = await apiRequest<{ items: SeekerRow[] }>(`/api/seekers?${params.toString()}`);
      setRows(data.items);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [tab, q]);

  useEffect(() => {
    void load();
  }, [load]);

  async function viewDocument(seeker: SeekerRow) {
    if (!seeker.hasDocument) return;
    setDocSeeker(seeker);
    setDocLoading(true);
    setDocUrl(null);
    try {
      const res = await fetch(`/api/seekers/${seeker.id}/document`, { cache: "no-store" });
      if (!res.ok) throw new Error("doc");
      const blob = await res.blob();
      setDocUrl(URL.createObjectURL(blob));
    } catch {
      toast({ variant: "destructive", description: t("jobs.errors.not_found") });
    } finally {
      setDocLoading(false);
    }
  }

  function closeDoc() {
    if (docUrl) URL.revokeObjectURL(docUrl);
    setDocUrl(null);
    setDocSeeker(null);
  }

  async function approve(seeker: SeekerRow) {
    setBusyId(seeker.id);
    try {
      await apiRequest(`/api/seekers/${seeker.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "approve" }),
      });
      toast({ description: t("seekersPage.approveOk") });
      await load();
    } catch (e) {
      toast({ variant: "destructive", description: reviewError(t, e) });
    } finally {
      setBusyId(null);
    }
  }

  async function reject() {
    if (!rejectFor) return;
    setBusyId(rejectFor.id);
    try {
      await apiRequest(`/api/seekers/${rejectFor.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "reject", reason: rejectReason.trim() }),
      });
      toast({ description: t("seekersPage.rejectOk") });
      setRejectFor(null);
      setRejectReason("");
      await load();
    } catch (e) {
      toast({ variant: "destructive", description: reviewError(t, e) });
    } finally {
      setBusyId(null);
    }
  }

  function reviewError(tt: (k: string) => string, e: unknown): string {
    const code = (e as { code?: string })?.code ?? "";
    const map: Record<string, string> = {
      reason_required: "jobs.errors.reason_required",
      bad_transition: "jobs.errors.bad_transition",
      not_found: "jobs.errors.not_found",
      forbidden: "common.forbidden",
      network: "common.networkError",
    };
    return tt(map[code] ?? "jobs.errors.internal_error");
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title={t("seekersPage.title")}
        subtitle={t("seekersPage.subtitle")}
        icon={<BadgeCheck />}
        actions={
          <Button variant="outline" size="sm" className="gap-1.5" onClick={() => void load()}>
            <RefreshCcw className="size-3.5" aria-hidden />
            {t("common.refresh")}
          </Button>
        }
      />

      {/* الفلاتر */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap items-center gap-1.5" role="tablist" aria-label={t("seekersPage.title")}>
          {STATUS_TABS.map((s) => (
            <Button
              key={s}
              variant={tab === s ? "secondary" : "ghost"}
              size="sm"
              className={cn("font-semibold", tab === s && "text-foreground")}
              onClick={() => setTab(s)}
              role="tab"
              aria-selected={tab === s}
            >
              {t(
                s === "all"
                  ? "seekersPage.filterAll"
                  : s === "pending"
                    ? "seekersPage.filterPending"
                    : s === "approved"
                      ? "seekersPage.filterApproved"
                      : "seekersPage.filterRejected"
              )}
            </Button>
          ))}
        </div>
        <div className="relative ms-auto w-full max-w-xs">
          <Search className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t("seekersPage.searchPlaceholder")}
            className="ps-9"
            maxLength={120}
            aria-label={t("seekersPage.searchPlaceholder")}
          />
        </div>
      </div>

      <ListState
        loading={loading && rows.length === 0}
        error={error}
        empty={!error && !loading && rows.length === 0}
        onRetry={() => void load()}
      />

      {!loading && !error && rows.length > 0 && (
        <div className="grid gap-4 lg:grid-cols-2">
          {rows.map((s) => (
            <Card key={s.id} className="border-border/70">
              <CardContent className="space-y-3 p-5">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate font-bold text-foreground">{s.fullName}</p>
                    <div className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-muted-foreground">
                      <a href={`mailto:${s.email}`} className="flex items-center gap-1 underline-offset-4 hover:underline" dir="ltr">
                        <Mail className="size-3 shrink-0" aria-hidden />
                        {s.email}
                      </a>
                      <a href={`tel:${s.phone.replace(/\s/g, "")}`} className="flex items-center gap-1 underline-offset-4 hover:underline" dir="ltr">
                        <Smartphone className="size-3 shrink-0" aria-hidden />
                        {s.phone}
                      </a>
                    </div>
                    <p className="mt-1 text-[11px] text-muted-foreground/80">
                      {t("seekersPage.registeredOn", { date: formatDate(s.createdAt.slice(0, 10), locale) })}
                    </p>
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1">
                    <Badge variant={STATUS_VARIANT[s.status] ?? "secondary"}>
                      {s.status === "approved" && <CheckCircle2 className="size-3" aria-hidden />}
                      {s.status === "rejected" && <XCircle className="size-3" aria-hidden />}
                      {t(`jobs.me.status.${s.status}`)}
                    </Badge>
                    {s.hasApplications && (
                      <span className="text-[10px] font-semibold text-primary">{t("seekersPage.hasApplications")}</span>
                    )}
                  </div>
                </div>

                {/* التحقيق الآلي + الوثيقة */}
                <div className="flex flex-wrap items-center gap-1.5 text-xs">
                  <span className={cn("flex items-center gap-1 rounded-full border px-2 py-0.5", s.emailVerified ? "border-primary/35 bg-primary/10 text-primary" : "border-border text-muted-foreground")}>
                    <Mail className="size-3" aria-hidden />
                    {s.emailVerified ? t("seekersPage.emailVerified") : t("seekersPage.notVerified")}
                  </span>
                  <span className={cn("flex items-center gap-1 rounded-full border px-2 py-0.5", s.phoneVerified ? "border-primary/35 bg-primary/10 text-primary" : "border-border text-muted-foreground")}>
                    <Smartphone className="size-3" aria-hidden />
                    {s.phoneVerified ? t("seekersPage.phoneVerified") : t("seekersPage.notVerified")}
                  </span>
                  {s.telegramVerified && (
                    <span
                      className="flex items-center gap-1 rounded-full border border-primary/35 bg-primary/10 px-2 py-0.5 text-primary"
                      title={s.telegramUsername ? `@${s.telegramUsername}` : undefined}
                    >
                      <Send className="size-3" aria-hidden />
                      {t("seekersPage.telegramVerified")}
                    </span>
                  )}
                  {s.documentType && (
                    <span className="flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-muted-foreground">
                      <FileImage className="size-3" aria-hidden />
                      {t(`jobs.register.docTypes.${s.documentType}`)}
                    </span>
                  )}
                </div>

                {s.status === "rejected" && s.rejectionReason && (
                  <p className="rounded-md bg-destructive/10 p-2 text-xs font-medium text-destructive">
                    {t("jobs.me.rejectionReason", { reason: s.rejectionReason })}
                  </p>
                )}

                {/* الإجراءات */}
                <div className="flex flex-wrap items-center gap-1.5">
                  <Button
                    variant="outline"
                    size="sm"
                    className="gap-1.5"
                    disabled={!s.hasDocument}
                    onClick={() => void viewDocument(s)}
                  >
                    <FileImage className="size-3.5" aria-hidden />
                    {t("seekersPage.viewDoc")}
                  </Button>
                  {s.status !== "approved" && (
                    <Button
                      size="sm"
                      className="gap-1.5 font-semibold"
                      disabled={
                        busyId === s.id ||
                        !s.emailVerified ||
                        (!s.phoneVerified && !s.telegramVerified) ||
                        !s.hasDocument
                      }
                      onClick={() => void approve(s)}
                    >
                      {busyId === s.id ? <LoaderCircle className="size-3.5 animate-spin" aria-hidden /> : <CheckCircle2 className="size-3.5" aria-hidden />}
                      {t("seekersPage.approve")}
                    </Button>
                  )}
                  {s.status !== "rejected" && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="gap-1.5 text-destructive"
                      disabled={busyId === s.id || !s.hasDocument}
                      onClick={() => {
                        setRejectFor(s);
                        setRejectReason("");
                      }}
                    >
                      <UserRoundX className="size-3.5" aria-hidden />
                      {t("seekersPage.reject")}
                    </Button>
                  )}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* حوار الوثيقة */}
      <Dialog open={!!docSeeker} onOpenChange={(o) => !o && closeDoc()}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle className="truncate">{docSeeker?.fullName}</DialogTitle>
            <DialogDescription>
              {docSeeker?.documentType ? t(`jobs.register.docTypes.${docSeeker.documentType}`) : ""}
              {docSeeker?.documentName ? ` · ${docSeeker.documentName}` : ""}
            </DialogDescription>
          </DialogHeader>
          {docLoading ? (
            <div className="flex items-center justify-center py-16">
              <LoaderCircle className="size-6 animate-spin text-muted-foreground" aria-hidden />
            </div>
          ) : docUrl ? (
            // وثيقة من Blob URL (بيانات جلسة) لا من محسّن Next — بلا وسم img الخاص بـ Next
            <img src={docUrl} alt={docSeeker?.fullName ?? "document"} className="max-h-[60dvh] w-full rounded-lg object-contain" />
          ) : (
            <p className="py-10 text-center text-sm text-muted-foreground">{t("jobs.errors.not_found")}</p>
          )}
        </DialogContent>
      </Dialog>

      {/* حوار الرفض */}
      <Dialog open={!!rejectFor} onOpenChange={(o) => !o && setRejectFor(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("seekersPage.reject")}</DialogTitle>
            <DialogDescription>{rejectFor?.fullName}</DialogDescription>
          </DialogHeader>
          <div className="space-y-2 py-1">
            <Label htmlFor="reject-reason">{t("seekersPage.rejectReason")}</Label>
            <Textarea
              id="reject-reason"
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              placeholder={t("seekersPage.rejectReasonPlaceholder")}
              rows={3}
              maxLength={500}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRejectFor(null)}>
              {t("common.cancel")}
            </Button>
            <Button variant="destructive" onClick={() => void reject()} disabled={!rejectReason.trim() || busyId === rejectFor?.id} className="gap-2 font-semibold">
              {busyId === rejectFor?.id && <LoaderCircle className="size-4 animate-spin" aria-hidden />}
              {t("seekersPage.reject")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

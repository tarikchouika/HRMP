"use client";

// HRMP — مركز التقارير والتصدير (SPEC §4.4.1 — المرحلة 7)
// كل دور يرى تقاريره فقط: العامل قسيمته وبيانه، المشرف الحضور بلا أرقام أجور،
// المدير/المحاسب الملخصات والتصاريح، المالك ملخص المنصة.
// التوليد في الخادم (نفس الناتج في كل مكان) والتنزيل من النسخة الثابتة المخزنة.
import { useCallback, useEffect, useMemo, useState } from "react";
import { Download, FileDown, FileText, LoaderCircle, PencilLine, RefreshCcw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Separator } from "@/components/ui/separator";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import { useI18n } from "@/i18n/provider";
import { apiRequest, ListState, PageHeader } from "@/components/hrmp/org-bits";
import { deliverFile } from "@/lib/native-bridge";
import { localeLabels } from "@/i18n/config";

type KindInfo = { kind: string; formats: string[] };

type RecentDoc = {
  id: string;
  kind: string;
  format: string;
  language: string;
  targetLabel: string;
  refNumber: string;
  version: number;
  fileSize: number;
  createdAt: string;
  createdByName: string;
};

type GenerateResult = {
  id: string;
  refNumber: string;
  version: number;
  format: string;
  fileName: string;
  size: number;
  reused: boolean;
  downloadUrl: string;
};

type MyPayslip = { id: string; refNumber: string; periodLabel: string; netCents: number };
type PeriodRow = { id: string; year: number; month: number; status: string };
type PeriodDetail = { period: { id: string; status: string }; payslips: { id: string; refNumber: string; worker: { fullName: string } | null }[] };
// علاج بلاغ المالك 2026-10-25: الهدف يُختار من **كل أعضاء الشركة النشطين** (من GET /api/reports)
// لا من /api/payroll/workers — التي تتطلب payroll.approve (غائبة عن المحاسب/الكوأدمن)
// وتقتصر على دور «عامل» فتظهر القائمة فارغة في شركات بلا عمال.
type MemberRow = { userId: string; fullName: string; email: string; role: string };
type DeclarationRow = { id: string; authority: string; kind: string; periodKey: string; status: string };

// بطاقة الدور بجوار الاسم — يميّز المالك «عامل/مستخدم/إدارة» في قائمة الاختيار (طلب المالك)
const roleLabelKey = (role: string) =>
  ({
    super_admin: "dashboard.roleSuperAdmin",
    admin: "dashboard.roleAdmin",
    co_admin: "dashboard.roleCoAdmin",
    accountant: "dashboard.roleAccountant",
    employee: "dashboard.roleEmployee",
  })[role] ?? "dashboard.roleEmployee";

const LANGS = ["ar", "fr", "en", "es"] as const;

// حالة الفترة بمفاتيح مسطحة (درس بلاغ المالك 2026-10-24: المفتاح المتداخل
// payroll.status.${status} غير موجود في القواميس — كان يظهر خامًا «payroll.status.draft»
// في قوائم اختيار الفترات هنا؛ payroll-manager يستعمل المسطح منذ الأصل)
const PERIOD_STATUS_LABEL: Record<string, string> = {
  draft: "payroll.statusDraft",
  reviewing: "payroll.statusReviewing",
  approved: "payroll.statusApproved",
};

// تقرير المطابقة يقارن ملفًا رسميًا معتمدًا (data.ts: declaration_not_approved)
// — الحالات المؤهلة وحدها قابلة للاختيار، والبقية تُعرض معليّة بحالتها
const DECL_ELIGIBLE = ["approved", "exported", "filed"];

function periodStatusLabel(status: string): string {
  return PERIOD_STATUS_LABEL[status] ?? "";
}

function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function ReportsManager() {
  const { t, locale } = useI18n();
  const { toast } = useToast();

  const [kinds, setKinds] = useState<KindInfo[]>([]);
  const [recent, setRecent] = useState<RecentDoc[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  // دور الجلسة + أعضاء الشركة — من نفس استدعاء GET /api/reports (مصدر واحد موثوق)
  const [role, setRole] = useState<string>("");
  const [members, setMembers] = useState<MemberRow[]>([]);

  const [kind, setKind] = useState<string>("");
  const [language, setLanguage] = useState<string>(locale);
  const [includeEmployerShare, setIncludeEmployerShare] = useState(false);
  const [generating, setGenerating] = useState(false);
  // ملاحظة إدارية تُطبع في المستند — تغييرها يُنشئ نسخة جديدة مرقّمة (لا تعديل للقديم)
  const [note, setNote] = useState<string>("");
  // المستند قيد المراجعة (نسخة محدَّثة)
  const [reviseTarget, setReviseTarget] = useState<RecentDoc | null>(null);
  const [reviseNote, setReviseNote] = useState<string>("");
  const [revising, setRevising] = useState(false);

  // مصادر الأهداف
  const [myPayslips, setMyPayslips] = useState<MyPayslip[]>([]);
  const [periods, setPeriods] = useState<PeriodRow[]>([]);
  const [periodPayslips, setPeriodPayslips] = useState<PeriodDetail["payslips"]>([]);
  const [declarations, setDeclarations] = useState<DeclarationRow[]>([]);

  const [payslipId, setPayslipId] = useState("");
  const [periodId, setPeriodId] = useState("");
  const [workerId, setWorkerId] = useState("");
  const [declId, setDeclId] = useState("");
  const [year, setYear] = useState(new Date().getUTCFullYear());
  const [month, setMonth] = useState(new Date().getUTCMonth() + 1);

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const data = await apiRequest<{ kinds: KindInfo[]; recent: RecentDoc[]; role?: string; members?: MemberRow[] }>("/api/reports", { cache: "no-store" });
      setKinds(data.kinds);
      setRecent(data.recent);
      if (typeof data.role === "string") setRole(data.role);
      setMembers(data.members ?? []);
      if (!kind && data.kinds.length > 0) setKind(data.kinds[0].kind);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
     
  }, []);

  useEffect(() => {
    void load();
     
  }, []);

  // تحميل مصادر الأهداف حسب النوع المختار
  useEffect(() => {
    if (kind === "payslip") {
      setPeriodPayslips([]);
      setPayslipId("");
      apiRequest<{ payslips: MyPayslip[] }>("/api/my-payslips", { cache: "no-store" })
        .then((d) => setMyPayslips(d.payslips))
        .catch(() => setMyPayslips([]));
      // المدير يختار من فترة (كشوف أي عامل) — يُحمَّل فقط عند توفر الصلاحية
      apiRequest<{ periods: PeriodRow[] }>("/api/pay-periods", { cache: "no-store" })
        .then((d) => setPeriods(d.periods ?? []))
        .catch(() => setPeriods([]));
    } else if (kind === "payroll_summary") {
      apiRequest<{ periods: PeriodRow[] }>("/api/pay-periods", { cache: "no-store" })
        .then((d) => setPeriods(d.periods ?? []))
        .catch(() => setPeriods([]));
    } else if (kind === "compliance_report") {
      apiRequest<{ declarations: DeclarationRow[] }>("/api/declarations", { cache: "no-store" })
        .then((d) => setDeclarations(d.declarations ?? []))
        .catch(() => setDeclarations([]));
    }
     
  }, [kind]);

  // كشوف الفترة عند اختيار فترة (لمسار المدير)
  useEffect(() => {
    if (kind !== "payslip" || !periodId) return;
    setPeriodPayslips([]);
    setPayslipId("");
    apiRequest<PeriodDetail>(`/api/pay-periods/${periodId}`, { cache: "no-store" })
      .then((d) => setPeriodPayslips(d.payslips ?? []))
      .catch(() => setPeriodPayslips([]));
  }, [kind, periodId]);

  const kindInfo = useMemo(() => kinds.find((k) => k.kind === kind), [kinds, kind]);

  function targetReady(): boolean {
    switch (kind) {
      case "payslip":
        return !!payslipId;
      case "payroll_summary":
        return !!periodId;
      case "attendance_statement":
      case "hours_statement":
        // العامل: نفسه تلقائيًا (لا قائمة اختيار له — الهدف نفسه في الخادم)
        // كل الأدوار الأخرى: اختيار عضو إلزامي — لا «self» بعد الآن (علاج بلاغ
        // المالك 2026-10-25: القائمة الفارغة كانت تفعّل الزر ثم تفشل 404 برسالة
        // «العامل المختار غير موجود في الشركة» بلا أي خيار ظاهر للاختيار)
        return role === "employee" ? true : !!workerId;
      case "compliance_report":
        return !!declId && DECL_ELIGIBLE.includes(declarations.find((d) => d.id === declId)?.status ?? "");
      default:
        return true;
    }
  }

  async function generate(format: string) {
    if (!kind || !targetReady()) return;
    setGenerating(true);
    try {
      const body: Record<string, unknown> = { kind, targetId: "", format, language };
      const trimmedNote = note.trim();
      if (trimmedNote) body.note = trimmedNote;
      switch (kind) {
        case "payslip":
          body.targetId = payslipId;
          if (includeEmployerShare) body.includeEmployerShare = true;
          break;
        case "payroll_summary":
          body.targetId = periodId;
          break;
        case "attendance_statement":
        case "hours_statement":
          // العامل: نفسه (يستبدله الخادم بجلسته) — غيره: العضو المختار حصرًا (لا احتياط «self»)
          body.targetId = role === "employee" ? "self" : workerId;
          body.year = year;
          body.month = month;
          break;
        case "compliance_report":
          body.targetId = declId;
          break;
        default:
          body.targetId = "platform";
      }
      const result = await apiRequest<GenerateResult>("/api/reports/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      toast({
        description: result.reused ? t("reports.exportReused") : t("reports.exportOk"),
      });
      // التنزيل من النسخة الثابتة (داخل تطبيق أندرويد: مشاركة أصلية — حفظ/فتح/إرسال)
      const res = await fetch(result.downloadUrl, { cache: "no-store" });
      if (!res.ok) throw new Error("download_failed");
      await deliverFile(await res.blob(), result.fileName);
      void load();
    } catch (e) {
      const code = (e as { message?: string })?.message ?? "";
      if (code.includes("period_not_approved")) {
        toast({ variant: "destructive", description: t("reports.draftBlocked") });
      } else if (code.includes("no_wage_access")) {
        toast({ variant: "destructive", description: t("reports.noWageAccess") });
      } else if (code.includes("worker_missing")) {
        toast({ variant: "destructive", description: t("reports.workerPickRequired") });
      } else if (code.includes("worker_not_in_company")) {
        toast({ variant: "destructive", description: t("reports.workerMissing") });
      } else if (code.includes("declaration_not_approved")) {
        toast({ variant: "destructive", description: t("reports.declarationNotApproved") });
      } else {
        toast({ variant: "destructive", description: t("reports.exportFailed") });
      }
    } finally {
      setGenerating(false);
    }
  }

  /** تنزيل مستند من رابط تنزيله (اسم الملف من الترويسة — أندرويد: مشاركة أصلية) */
  async function downloadFrom(downloadUrl: string, fileName?: string) {
    const res = await fetch(downloadUrl, { cache: "no-store" });
    if (!res.ok) throw new Error("download_failed");
    const blob = await res.blob();
    const disposition = res.headers.get("Content-Disposition") ?? "";
    const match = /filename="([^"]+)"/.exec(disposition);
    await deliverFile(blob, fileName ?? match?.[1] ?? "document");
  }

  /** إنشاء نسخة محدَّثة (ملاحظة جديدة ⇒ إصدار جديد؛ القديم يبقى للتدقيق) */
  async function revise() {
    if (!reviseTarget) return;
    if (!reviseNote.trim()) {
      toast({ variant: "destructive", description: t("reports.reviseNoteRequired") });
      return;
    }
    setRevising(true);
    try {
      const res = await fetch(`/api/reports/${reviseTarget.id}/revise`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ note: reviseNote }),
      });
      if (!res.ok) throw new Error("revise_failed");
      const result = (await res.json()) as { downloadUrl?: string; fileName?: string };
      if (result.downloadUrl) await downloadFrom(result.downloadUrl, result.fileName);
      toast({ description: t("reports.reviseOk") });
      setReviseTarget(null);
      setReviseNote("");
      void load();
    } catch {
      toast({ variant: "destructive", description: t("reports.reviseFailed") });
    } finally {
      setRevising(false);
    }
  }

  async function redownload(docId: string) {
    try {
      const res = await fetch(`/api/reports/${docId}/download`, { cache: "no-store" });
      if (!res.ok) throw new Error("download_failed");
      const blob = await res.blob();
      const disposition = res.headers.get("Content-Disposition") ?? "";
      const match = /filename="([^"]+)"/.exec(disposition);
      await deliverFile(blob, match?.[1] ?? "document");
    } catch {
      toast({ variant: "destructive", description: t("reports.exportFailed") });
    }
  }

  const needsWorkerSelect = (kind === "attendance_statement" || kind === "hours_statement") && role !== "employee";

  return (
    <div className="space-y-6">
      <PageHeader title={t("reports.title")} subtitle={t("reports.subtitle")}>
        <Button size="sm" variant="outline" onClick={() => void load()} className="gap-1.5">
          <RefreshCcw className="size-3.5" aria-hidden />
          {t("common.retry")}
        </Button>
      </PageHeader>

      <ListState loading={loading} error={error} empty={kinds.length === 0} onRetry={() => void load()} />

      {!loading && !error && (
        <div className="grid gap-6 lg:grid-cols-2">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-base">
                <FileText className="size-4" aria-hidden />
                {t("reports.generate")}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-1.5">
                <Label>{t("reports.selectKind")}</Label>
                <Select value={kind} onValueChange={setKind}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {kinds.map((k) => (
                      <SelectItem key={k.kind} value={k.kind}>
                        {t(`reports.kind.${k.kind}`)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {kind === "payslip" && (
                <div className="space-y-3">
                  <div className="space-y-1.5">
                    <Label>{t("reports.selectPayslip")}</Label>
                    {myPayslips.length > 0 && (
                      <Select value={payslipId} onValueChange={setPayslipId}>
                        <SelectTrigger className="w-full">
                          <SelectValue placeholder={t("reports.employeePayslipsHint")} />
                        </SelectTrigger>
                        <SelectContent>
                          {myPayslips.map((ps) => (
                            <SelectItem key={ps.id} value={ps.id}>
                              {ps.periodLabel} — {ps.refNumber}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                  </div>
                  {periods.length > 0 && (
                    <div className="space-y-1.5">
                      <Label>{t("reports.selectPeriod")}</Label>
                      <Select value={periodId} onValueChange={setPeriodId}>
                        <SelectTrigger className="w-full">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {periods.map((p) => (
                            <SelectItem key={p.id} value={p.id}>
                              {p.year}-{String(p.month).padStart(2, "0")} · {periodStatusLabel(p.status) ? t(periodStatusLabel(p.status)) : p.status}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      {periodId && periodPayslips.length > 0 && (
                        <Select value={payslipId} onValueChange={setPayslipId}>
                          <SelectTrigger className="w-full">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {periodPayslips.map((ps) => (
                              <SelectItem key={ps.id} value={ps.id}>
                                {ps.refNumber} — {ps.worker?.fullName ?? "—"}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      )}
                    </div>
                  )}
                </div>
              )}

              {kind === "payroll_summary" && (
                <div className="space-y-1.5">
                  <Label>{t("reports.selectPeriod")}</Label>
                  <Select value={periodId} onValueChange={setPeriodId}>
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder={t("reports.periodRequired")} />
                    </SelectTrigger>
                    <SelectContent>
                      {periods.map((p) => (
                        <SelectItem key={p.id} value={p.id}>
                          {p.year}-{String(p.month).padStart(2, "0")} · {periodStatusLabel(p.status) ? t(periodStatusLabel(p.status)) : p.status}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}

              {needsWorkerSelect && (
                <div className="space-y-3">
                  <div className="space-y-1.5">
                    <Label>{t("reports.selectWorker")}</Label>
                    {members.length > 0 ? (
                      <Select value={workerId} onValueChange={setWorkerId}>
                        <SelectTrigger className="w-full">
                          <SelectValue placeholder={t("reports.workerRequired")} />
                        </SelectTrigger>
                        <SelectContent>
                          {members.map((m) => (
                            <SelectItem key={m.userId} value={m.userId}>
                              {m.fullName} — {t(roleLabelKey(m.role))}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    ) : (
                      /* لا أعضاء نشطين أصلاً: سبب واضح بدل اختفاء المنتقي (علاج بلاغ
                        المالك 2026-10-25: كان المنتقي يختفي والأزرار تعمل ثم تفشل) */
                      <p className="text-xs text-muted-foreground">{t("reports.noMembers")}</p>
                    )}
                    {/* إلزامية الاختيار مذكورة صراحةً — الزر معطّل حتى الاختيار */}
                    <p className="text-xs text-muted-foreground">{t("reports.workerRequiredHint")}</p>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1.5">
                      <Label>{t("reports.year")}</Label>
                      <Select value={String(year)} onValueChange={(v) => setYear(Number(v))}>
                        <SelectTrigger className="w-full">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {[year + 1, year, year - 1, year - 2].map((y) => (
                            <SelectItem key={y} value={String(y)}>
                              {y}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-1.5">
                      {/* monthLabel وليس month: الأخيرة خريطة أرقام→أسماء (درس لقطات المالك 2026-10-19) */}
                      <Label>{t("reports.monthLabel")}</Label>
                      <Select value={String(month)} onValueChange={(v) => setMonth(Number(v))}>
                        <SelectTrigger className="w-full">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
                            <SelectItem key={m} value={String(m)}>
                              {t(`reports.month.${m}`)}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                  <p className="text-xs text-muted-foreground">{t("reports.attendanceNote")}</p>
                </div>
              )}

              {kind === "compliance_report" && (
                <div className="space-y-1.5">
                  <Label>{t("reports.selectDeclaration")}</Label>
                  {declarations.length === 0 ? (
                    /* لا تصاريح أصلًا: سبب واضح بدل قائمة فارغة وأزرار معطلة بلا تفسير */
                    <p className="text-xs text-muted-foreground">{t("reports.noDeclarations")}</p>
                  ) : (
                    <>
                    <Select value={declId} onValueChange={setDeclId}>
                      <SelectTrigger className="w-full">
                        <SelectValue placeholder={t("reports.declarationRequired")} />
                      </SelectTrigger>
                      <SelectContent>
                        {declarations.map((d) => (
                          <SelectItem key={d.id} value={d.id} disabled={!DECL_ELIGIBLE.includes(d.status)}>
                            {d.authority.toUpperCase()} · {t(`specRegistry.kinds.${d.kind}`)} · {d.periodKey} — {t(`declarations.statuses.${d.status}`)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <p className="text-xs text-muted-foreground">{t("reports.declarationEligibleHint")}</p>
                    </>
                  )}
                </div>
              )}

              <div className="space-y-1.5">
                <Label>{t("reports.language")}</Label>
                <Select value={language} onValueChange={setLanguage}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {LANGS.map((l) => (
                      <SelectItem key={l} value={l}>
                        {localeLabels[l]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {kind === "payslip" && (
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={includeEmployerShare}
                    onChange={(e) => setIncludeEmployerShare(e.target.checked)}
                    className="size-4"
                  />
                  {t("reports.includeEmployerShare")}
                </label>
              )}

              <div className="space-y-1.5">
                <Label htmlFor="hrmp-report-note">{t("reports.noteOn")}</Label>
                <Textarea
                  id="hrmp-report-note"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder={t("reports.notePlaceholder")}
                  rows={3}
                  maxLength={2000}
                />
              </div>

              <Separator />

              <div className="space-y-2">
                {/* الجوال: شبكة أعمدة متساوية بلا التفاف ناقص (علاج توافق الجوال 2026-10-23) */}
                <div className="flex flex-wrap items-center gap-2 max-sm:grid max-sm:grid-cols-4 max-sm:[&>span]:col-span-4">
                  <span className="text-sm text-muted-foreground">{t("reports.format")}:</span>
                  {(kindInfo?.formats ?? []).map((f) => (
                    <Button
                      key={f}
                      size="sm"
                      disabled={generating || !targetReady()}
                      onClick={() => void generate(f)}
                      className="gap-1.5 uppercase max-sm:w-full"
                      title={
                        f === "csv"
                          ? t("reports.formatHintCsv")
                          : f === "docx"
                            ? t("reports.formatHintEditable")
                            : undefined
                      }
                    >
                      {generating ? <LoaderCircle className="size-3.5 animate-spin" aria-hidden /> : <FileDown className="size-3.5" aria-hidden />}
                      {f}
                    </Button>
                  ))}
                </div>
                <p className="text-xs text-muted-foreground">{t("reports.formatHintEditable")}</p>
                {kindInfo?.formats.includes("csv") ? (
                  <p className="text-xs text-muted-foreground">{t("reports.csvHint")}</p>
                ) : null}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-base">
                <Download className="size-4" aria-hidden />
                {t("reports.recentExports")}
              </CardTitle>
            </CardHeader>
            <CardContent>
              {recent.length === 0 ? (
                <p className="py-6 text-center text-sm text-muted-foreground">{t("reports.noExports")}</p>
              ) : (
                <>
                {/* جدول الحواسيب — بطاقات الهاتف أدناه (علاج توافق الجوال 2026-10-23) */}
                <div className="hidden md:block">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t("reports.colKind")}</TableHead>
                      <TableHead>{t("reports.colRef")}</TableHead>
                      <TableHead>{t("reports.colLang")}</TableHead>
                      <TableHead>{t("reports.colWhen")}</TableHead>
                      <TableHead className="w-16" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {recent.map((d) => (
                      <TableRow key={d.id}>
                        <TableCell>
                          <div className="flex flex-col gap-0.5">
                            <span className="text-sm">{t(`reports.kind.${d.kind}`)}</span>
                            <span dir="ltr" className="font-mono text-[11px] text-muted-foreground">{d.targetLabel}</span>
                          </div>
                        </TableCell>
                        <TableCell>
                          <div className="flex flex-col gap-0.5">
                            <span dir="ltr" className="font-mono text-xs">{d.refNumber}</span>
                            <Badge variant="outline" className="w-fit text-[10px] uppercase">
                              {d.format} · v{d.version}
                            </Badge>
                          </div>
                        </TableCell>
                        <TableCell className="text-sm">{localeLabels[d.language as keyof typeof localeLabels] ?? d.language}</TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          <div className="flex flex-col">
                            <span dir="ltr">{new Date(d.createdAt).toLocaleString()}</span>
                            <span>{d.createdByName}</span>
                          </div>
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center justify-end gap-1">
                            <Button
                              size="icon"
                              variant="ghost"
                              onClick={() => {
                                setReviseTarget(d);
                                setReviseNote("");
                              }}
                              aria-label={t("reports.revise")}
                              title={t("reports.revise")}
                            >
                              <PencilLine className="size-4" aria-hidden />
                            </Button>
                            <Button size="icon" variant="ghost" onClick={() => void redownload(d.id)} aria-label={t("reports.download")}>
                              <Download className="size-4" aria-hidden />
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                </div>
                {/* بطاقات الهاتف: مرجع كامل بلا اقتطاع مهما طالت الترجمات */}
                <div className="space-y-3 md:hidden">
                  {recent.map((d) => (
                    <div key={d.id} className="rounded-xl border border-border/70 bg-card p-3.5">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="text-sm font-semibold">{t(`reports.kind.${d.kind}`)}</span>
                        <Badge variant="outline" className="text-[10px] uppercase">{d.format} · v{d.version}</Badge>
                      </div>
                      <p className="mt-1 font-mono text-xs break-all" dir="ltr">{d.refNumber}</p>
                      {d.targetLabel ? <p className="font-mono text-[11px] text-muted-foreground break-all" dir="ltr">{d.targetLabel}</p> : null}
                      <p className="mt-1 text-xs text-muted-foreground">
                        {localeLabels[d.language as keyof typeof localeLabels] ?? d.language} · <span dir="ltr">{new Date(d.createdAt).toLocaleString()}</span>
                      </p>
                      <p className="text-xs text-muted-foreground">{d.createdByName}</p>
                      <div className="mt-2 flex gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => { setReviseTarget(d); setReviseNote(""); }}
                        >
                          <PencilLine className="size-4" aria-hidden />
                          {t("reports.revise")}
                        </Button>
                        <Button size="sm" variant="outline" onClick={() => void redownload(d.id)}>
                          <Download className="size-4" aria-hidden />
                          {t("reports.download")}
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
                </>
              )}
            </CardContent>
          </Card>
        </div>
      )}

      <Dialog open={reviseTarget !== null} onOpenChange={(open) => !open && setReviseTarget(null)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{t("reports.reviseTitle")}</DialogTitle>
            <DialogDescription>{t("reports.reviseHint")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="hrmp-revise-note">{t("reports.noteLabel")}</Label>
            <Textarea
              id="hrmp-revise-note"
              value={reviseNote}
              onChange={(e) => setReviseNote(e.target.value)}
              placeholder={t("reports.notePlaceholder")}
              rows={4}
              maxLength={2000}
            />
            {reviseTarget ? (
              <p className="text-xs text-muted-foreground" dir="ltr">
                {reviseTarget.refNumber} · v{reviseTarget.version} · {reviseTarget.format}
              </p>
            ) : null}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setReviseTarget(null)}>
              {t("common.cancel")}
            </Button>
            <Button onClick={() => void revise()} disabled={revising} className="gap-1.5">
              {revising ? <LoaderCircle className="size-3.5 animate-spin" aria-hidden /> : <PencilLine className="size-3.5" aria-hidden />}
              {t("reports.revise")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

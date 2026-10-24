"use client";

// HRMP — إدارة المستخدمين (المرحلة 9): إنشاء الحسابات للسوبر أدمن حصرًا (أو مفوَّض)،
// تعطيل/تفعيل وتعيين المسمى الوظيفي لمن يملك users.manage، ولوحة تفويض الصلاحيات
// للسوبر أدمن وحده. كلمة المرور الابتدائية تُعرض مرة واحدة في استجابة الإنشاء فقط.
// (علاج بلاغ المالك 2026-10-23): أسماء المستخدمين المحلية (تتبع لغة الواجهة) +
// حذف نهائي لمن يملك data.delete + بطاقات جوال بدل الجدول المعصور.
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import {
  UserPlus,
  Users,
  LoaderCircle,
  KeyRound,
  Copy,
  Check,
  Ban,
  CheckCircle2,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { useI18n } from "@/i18n/provider";
import { ListState, apiRequest, apiErrorMessage } from "@/components/hrmp/org-bits";
import { JOB_TITLE_CATEGORIES, jobTitleLabel } from "@/lib/job-titles";
import { LocaleNamesFields, EMPTY_LOCALE_NAMES, localeNamesFromRow, localeNamesBody, type LocaleNamesForm } from "@/components/hrmp/locale-names-fields";

const NONE = "none"; // قيمة حارسة (درس Radix Select — قيمة نصية فارغة مرفوضة)

type UserRow = {
  userId: string;
  email: string;
  fullName: string;
  baseName?: string;
  names?: string | null;
  phone: string | null;
  role: string;
  isActive: boolean;
  lastLoginAt: string | null;
  jobTitleKey: string | null;
  jobTitleCustom: string | null;
};

type DelegationRow = {
  id: string;
  granteeId: string;
  granteeName: string;
  permission: string;
  note: string | null;
  grantedAt: string;
  grantedByName: string;
  expiresAt: string | null;
};

const ROLE_KEYS = ["super_admin", "admin", "co_admin", "accountant", "employee"] as const;
const roleLabelKey = (role: string) =>
  ({
    super_admin: "dashboard.roleSuperAdmin",
    admin: "dashboard.roleAdmin",
    co_admin: "dashboard.roleCoAdmin",
    accountant: "dashboard.roleAccountant",
    employee: "dashboard.roleEmployee",
  })[role] ?? "dashboard.roleEmployee";

/** (بلاغ المالك 2026-10-25 — خلل خانة تفويض الصلاحيات): كان حوار/جدول التفويض
 *  يعرض المفاتيح الخام (users.create…) بلا ترجمة. الآن: ترجمة من قسم permissions
 *  في القاموس (المفتاح بالنقطة يُفكّ على الشرطة السفلية) مع سقوط آمن للمفتاح الخام
 *  لقيم جديدة غير مفهرسة بعد. */
const permissionLabelKey = (permission: string) => `permissions.${permission.replace(/\./g, "_")}`;

export function UsersManager({
  canCreate,
  isSuperAdmin,
  myUserId,
  canDelete,
  canResetPassword,
}: {
  canCreate: boolean;
  isSuperAdmin: boolean;
  myUserId: string;
  canDelete: boolean;
  canResetPassword: boolean;
}) {
  const { t, locale } = useI18n();
  const { toast } = useToast();

  const [rows, setRows] = useState<UserRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [q, setQ] = useState("");

  const [createOpen, setCreateOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [initialPassword, setInitialPassword] = useState<{ email: string; password: string } | null>(null);

  const [form, setForm] = useState({
    fullName: "",
    email: "",
    phone: "",
    role: "employee" as (typeof ROLE_KEYS)[number],
    jobTitleKey: NONE as string,
    password: "",
  });
  const [formNames, setFormNames] = useState<LocaleNamesForm>(EMPTY_LOCALE_NAMES);

  // حوار الحذف النهائي (أمر المالك 2026-10-23)
  const [deleteRow, setDeleteRow] = useState<UserRow | null>(null);
  const [deleteReason, setDeleteReason] = useState("");
  const [deleting, setDeleting] = useState(false);

  // حوار تغيير كلمة السر (بلاغ المالك 2026-10-25): users.password — السوبر أدمن
  // بطبعه أو مفوَّض؛ النتيجة تُعرض مرة واحدة ككلمة المرور الابتدائية
  const [resetRow, setResetRow] = useState<UserRow | null>(null);
  const [resetSaving, setResetSaving] = useState(false);
  const [newPassword, setNewPassword] = useState<{ email: string; password: string } | null>(null);

  // تفويض
  const [delegations, setDelegations] = useState<DelegationRow[]>([]);
  const [delegable, setDelegable] = useState<string[]>([]);
  const [delegOpen, setDelegOpen] = useState(false);
  const [delegSaving, setDelegSaving] = useState(false);
  const [delegForm, setDelegForm] = useState({ granteeId: NONE, permission: NONE, expiresInDays: "", note: "" });

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const data = await apiRequest<{ users: UserRow[] }>("/api/users");
      setRows(data.users);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  const loadDelegations = useCallback(async () => {
    if (!isSuperAdmin) return;
    try {
      const data = await apiRequest<{ delegations: DelegationRow[]; delegablePermissions: string[] }>(
        "/api/users/delegations",
      );
      setDelegations(data.delegations);
      setDelegable(data.delegablePermissions);
    } catch {
      /* تحسينية */
    }
  }, [isSuperAdmin]);

  useEffect(() => {
    void load();
    void loadDelegations();
  }, [load, loadDelegations]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter((r) =>
      [r.fullName, r.email, r.jobTitleKey ? jobTitleLabel(r.jobTitleKey, locale) ?? "" : ""]
        .some((v) => v.toLowerCase().includes(needle)),
    );
  }, [rows, q, locale]);

  async function onCreate(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (saving) return;
    if (form.fullName.trim().length < 2 || !form.email.includes("@")) {
      toast({ variant: "destructive", description: t("common.invalidInput") });
      return;
    }
    setSaving(true);
    try {
      const body = JSON.stringify({
        fullName: form.fullName.trim(),
        names: localeNamesBody(formNames),
        email: form.email.trim(),
        phone: form.phone.trim() || null,
        role: form.role,
        jobTitleKey: form.jobTitleKey === NONE ? null : form.jobTitleKey,
        ...(form.password.trim() ? { password: form.password.trim() } : {}),
      });
      const data = await apiRequest<{ initialPassword: string; user: { email: string } }>("/api/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });
      setCreateOpen(false);
      setInitialPassword({ email: data.user.email, password: data.initialPassword });
      setForm({ fullName: "", email: "", phone: "", role: "employee", jobTitleKey: NONE, password: "" });
      setFormNames(EMPTY_LOCALE_NAMES);
      await load();
    } catch (err) {
      toast({ variant: "destructive", description: apiErrorMessage(t, err) });
    } finally {
      setSaving(false);
    }
  }

  async function toggleActive(row: UserRow) {
    const next = !row.isActive;
    try {
      await apiRequest(`/api/users/${row.userId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive: next }),
      });
      await load();
    } catch (err) {
      toast({ variant: "destructive", description: apiErrorMessage(t, err) });
    }
  }

  async function setJobTitle(row: UserRow, jobTitleKey: string) {
    try {
      await apiRequest(`/api/users/${row.userId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobTitleKey: jobTitleKey === NONE ? null : jobTitleKey }),
      });
      await load();
    } catch (err) {
      toast({ variant: "destructive", description: apiErrorMessage(t, err) });
    }
  }

  async function grantDelegation(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (delegSaving) return;
    if (delegForm.granteeId === NONE || delegForm.permission === NONE) {
      toast({ variant: "destructive", description: t("common.invalidInput") });
      return;
    }
    setDelegSaving(true);
    try {
      await apiRequest("/api/users/delegations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          granteeId: delegForm.granteeId,
          permission: delegForm.permission,
          note: delegForm.note.trim() || null,
          expiresInDays: delegForm.expiresInDays.trim() ? Number(delegForm.expiresInDays) : null,
        }),
      });
      setDelegOpen(false);
      setDelegForm({ granteeId: NONE, permission: NONE, expiresInDays: "", note: "" });
      await loadDelegations();
    } catch (err) {
      toast({ variant: "destructive", description: apiErrorMessage(t, err) });
    } finally {
      setDelegSaving(false);
    }
  }

  async function revokeDelegation(id: string) {
    try {
      await apiRequest(`/api/users/delegations?id=${encodeURIComponent(id)}`, { method: "DELETE" });
      await loadDelegations();
    } catch (err) {
      toast({ variant: "destructive", description: apiErrorMessage(t, err) });
    }
  }

  /** تغيير كلمة سر مستخدم (بلاغ المالك 2026-10-25): users.password — سوبر أدمن
   *  بطبعه أو مفوَّض؛ الخادم يحمي كلمة سوبر أدمن من غير المالك ويبطل الجلسات */
  async function confirmResetPassword(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!resetRow || resetSaving) return;
    const custom = (document.getElementById("u-reset-password") as HTMLInputElement | null)?.value?.trim() ?? "";
    setResetSaving(true);
    try {
      const data = await apiRequest<{ newPassword: string; user: { email: string } }>(
        `/api/users/${resetRow.userId}/password`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(custom ? { password: custom } : {}),
        },
      );
      setResetRow(null);
      setNewPassword({ email: data.user.email, password: data.newPassword });
      toast({ description: t("usersPage.resetPasswordDone") });
    } catch (err) {
      toast({ variant: "destructive", description: apiErrorMessage(t, err) });
    } finally {
      setResetSaving(false);
    }
  }

  /** الحذف النهائي (data.delete): حرّاس السلامة في الخادم — رسالة مرشدة عند الرفض */
  async function confirmDelete() {
    if (!deleteRow || deleting) return;
    setDeleting(true);
    try {
      await apiRequest(`/api/users/${deleteRow.userId}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: deleteReason.trim() || null }),
      });
      setDeleteRow(null);
      setDeleteReason("");
      toast({ description: t("usersPage.deleted") });
      await load();
    } catch (err) {
      toast({ variant: "destructive", description: apiErrorMessage(t, err) });
    } finally {
      setDeleting(false);
    }
  }

  if (loading) return <ListState loading error={false} empty={false} />;
  if (error) return <ListState loading={false} error empty={false} onRetry={() => void load()} />;

  return (
    <div className="flex flex-col gap-6">
      {/* كلمة المرور الابتدائية / الجديدة — تُعرض مرة واحدة (تغيير كلمة السر بلاغ 2026-10-25) */}
      {(initialPassword || newPassword) && (() => {
        const shown = newPassword ?? initialPassword!;
        return (
        <div className="flex flex-col gap-2 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-900/40 dark:bg-amber-950/40 dark:text-amber-200">
          <span className="font-bold">{t(newPassword ? "usersPage.newPasswordTitle" : "usersPage.initialPasswordTitle")} — {shown.email}</span>
          <div className="flex items-center gap-2">
            <code dir="ltr" className="rounded bg-amber-100 px-2 py-1 font-mono text-base font-bold dark:bg-amber-900 dark:text-amber-100">
              {shown.password}
            </code>
            <Button
              variant="outline"
              size="sm"
              className="gap-2"
              onClick={() => {
                void navigator.clipboard?.writeText(shown.password).then(() =>
                  toast({ description: t("common.copy") }),
                );
              }}
            >
              <Copy className="size-3.5" aria-hidden />
              {t("common.copy")}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setInitialPassword(null);
                setNewPassword(null);
              }}
            >
              {t("common.ok")}
            </Button>
          </div>
          <span className="text-xs">{t(newPassword ? "usersPage.resetPasswordHint" : "usersPage.initialPasswordHint")}</span>
        </div>
        );
      })()}

      {/* التفويض — السوبر أدمن وحده */}
      {isSuperAdmin && (
        <Card className="border-border/70">
          {/* (بلاغ المالك 2026-10-25 — فيض الشاشة عند تغيير اللغة): كان الرأس صفًا واحدًا
              بزر nowrap — والترجمات الطويلة (Accorder une délégation…) تتجاوز 360px.
              الآن: تَفافُع عمودي على الجوال والزر يلتف نصّه بدل أن يفيض أفقياً. */}
          <CardHeader className="flex flex-col gap-2 pb-2 sm:flex-row sm:items-center sm:justify-between">
            <CardTitle className="flex items-center gap-2 text-base font-bold">
              <ShieldCheck className="size-4 text-primary" aria-hidden />
              {t("usersPage.delegationsTitle")}
            </CardTitle>
            <Button variant="outline" size="sm" onClick={() => setDelegOpen(true)} className="whitespace-normal gap-2">
              <KeyRound className="size-3.5 shrink-0" aria-hidden />
              {t("usersPage.grantDelegation")}
            </Button>
          </CardHeader>
          <CardContent>
            {delegations.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">{t("usersPage.noDelegations")}</p>
            ) : (
              <div className="max-h-64 overflow-y-auto rounded-lg border border-border/60">
                <Table>
                  <TableHeader className="sticky top-0 bg-muted/95 backdrop-blur">
                    <TableRow>
                      <TableHead className="text-xs">{t("usersPage.grantee")}</TableHead>
                      <TableHead className="text-xs">{t("usersPage.permission")}</TableHead>
                      <TableHead className="text-xs">{t("usersPage.expires")}</TableHead>
                      <TableHead className="text-xs">{t("common.actions")}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {delegations.map((d) => (
                      <TableRow key={d.id}>
                        <TableCell className="font-medium">{d.granteeName}</TableCell>
                        <TableCell className="min-w-40">
                          {/* (بلاغ المالك 2026-10-25): ترجمة الصلاحية بدل المفتاح الخام — المفتاح التقني يبقى في تلميح العنوان للتشخيص */}
                          <span
                            className="inline-block max-w-48 truncate rounded bg-muted px-1.5 py-0.5 text-xs font-medium"
                            title={d.permission}
                            dir="auto"
                          >
                            {t(permissionLabelKey(d.permission)).startsWith("permissions.") ? d.permission : t(permissionLabelKey(d.permission))}
                          </span>
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground tabular-nums">
                          {d.expiresAt
                            ? new Date(d.expiresAt).toLocaleDateString(locale)
                            : t("usersPage.noExpiry")}
                        </TableCell>
                        <TableCell>
                          <Button variant="ghost" size="icon" className="size-7 text-red-600" onClick={() => void revokeDelegation(d.id)} aria-label={t("usersPage.revoke")}>
                            <Trash2 className="size-3.5" aria-hidden />
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* قائمة المستخدمين */}
      <Card className="border-border/70">
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 pb-3">
          <CardTitle className="flex items-center gap-2 text-base font-bold">
            <Users className="size-4 text-primary" aria-hidden />
            {t("usersPage.listTitle")} ({rows.length})
          </CardTitle>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={t("common.search")}
              className="h-9 w-44 sm:w-56"
              aria-label={t("common.search")}
            />
            {canCreate && (
              <Button size="sm" onClick={() => setCreateOpen(true)} className="gap-2">
                <UserPlus className="size-4" aria-hidden />
                <span className="hidden sm:inline">{t("usersPage.createTitle")}</span>
                <span className="sm:hidden">+</span>
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {filtered.length === 0 ? (
            <p className="px-4 py-10 text-center text-sm text-muted-foreground">{t("common.noData")}</p>
          ) : (
            <div className="hidden max-h-[520px] overflow-y-auto md:block">
              <Table>
                <TableHeader className="sticky top-0 bg-muted/95 backdrop-blur">
                  <TableRow>
                    <TableHead className="text-xs">{t("usersPage.user")}</TableHead>
                    <TableHead className="text-xs">{t("usersPage.jobTitle")}</TableHead>
                    <TableHead className="text-xs">{t("usersPage.role")}</TableHead>
                    <TableHead className="text-xs">{t("common.status")}</TableHead>
                    <TableHead className="text-xs">{t("common.actions")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filtered.map((r) => (
                    <TableRow key={r.userId}>
                      <TableCell>
                        <div className="flex flex-col leading-tight">
                          <span className="font-medium">{r.fullName}</span>
                          <span className="text-[11px] text-muted-foreground" dir="ltr">{r.email}</span>
                        </div>
                      </TableCell>
                      <TableCell className="min-w-44">
                        <Select
                          value={r.jobTitleKey ?? NONE}
                          onValueChange={(v) => void setJobTitle(r, v)}
                          disabled={r.userId === myUserId && false}
                        >
                          <SelectTrigger className="h-8 w-40 text-xs" aria-label={t("usersPage.jobTitle")}>
                            <SelectValue placeholder={t("presence.noJobTitle")} />
                          </SelectTrigger>
                          <SelectContent className="max-h-72">
                            <SelectItem value={NONE}>{t("presence.noJobTitle")}</SelectItem>
                            {JOB_TITLE_CATEGORIES.map((cat) => (
                              <div key={cat.key}>
                                <div className="px-2 pt-2 text-[11px] font-bold text-muted-foreground">
                                  {cat.labels[locale]}
                                </div>
                                {cat.titles.map((title) => (
                                  <SelectItem key={title.key} value={title.key} className="text-xs">
                                    {title.labels[locale]}
                                  </SelectItem>
                                ))}
                              </div>
                            ))}
                          </SelectContent>
                        </Select>
                      </TableCell>
                      <TableCell>
                        <Badge variant="secondary" className="font-semibold">{t(roleLabelKey(r.role))}</Badge>
                      </TableCell>
                      <TableCell>
                        {r.isActive ? (
                          <Badge className="bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300">
                            {t("common.active")}
                          </Badge>
                        ) : (
                          <Badge variant="destructive">{t("common.suspended")}</Badge>
                        )}
                      </TableCell>
                      <TableCell>
                        {r.userId === myUserId ? (
                          <span className="text-[11px] text-muted-foreground">{t("usersPage.you")}</span>
                        ) : (
                          <div className="flex items-center gap-1.5">
                            {canResetPassword && (
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-8 gap-1.5 px-2 text-xs"
                                onClick={() => setResetRow(r)}
                                aria-label={t("usersPage.resetPasswordTitle")}
                                title={t("usersPage.resetPasswordTitle")}
                              >
                                <KeyRound className="size-3.5 text-primary" aria-hidden />
                              </Button>
                            )}
                            <Button
                              variant={r.isActive ? "outline" : "secondary"}
                              size="sm"
                              className="h-8 gap-1.5 px-2 text-xs"
                              onClick={() => void toggleActive(r)}
                            >
                              {r.isActive ? (
                                <>
                                  <Ban className="size-3.5 text-red-600" aria-hidden />
                                  {t("usersPage.deactivate")}
                                </>
                              ) : (
                                <>
                                  <CheckCircle2 className="size-3.5 text-green-600" aria-hidden />
                                  {t("usersPage.activate")}
                                </>
                              )}
                            </Button>
                            {canDelete && (
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-8 gap-1.5 px-2 text-xs text-red-600 hover:text-red-700"
                                onClick={() => setDeleteRow(r)}
                              >
                                <Trash2 className="size-3.5" aria-hidden />
                                {t("common.delete")}
                              </Button>
                            )}
                          </div>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
          {/* بطاقات الهاتف — بلا تمرير أفقي مهما طالت أسماء الأدوار بالترجمات (بلاغ 2026-10-23) */}
          {filtered.length > 0 && (
            <div className="space-y-3 p-3 md:hidden">
              {filtered.map((r) => (
                <div key={r.userId} className="rounded-xl border border-border/70 bg-card p-3.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{r.fullName}</span>
                    <Badge variant="secondary" className="font-semibold">{t(roleLabelKey(r.role))}</Badge>
                    {r.isActive ? (
                      <Badge className="bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300">{t("common.active")}</Badge>
                    ) : (
                      <Badge variant="destructive">{t("common.suspended")}</Badge>
                    )}
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground" dir="ltr">{r.email}</p>
                  <div className="mt-2.5">
                    <Select
                      value={r.jobTitleKey ?? NONE}
                      onValueChange={(v) => void setJobTitle(r, v)}
                    >
                      <SelectTrigger className="h-9 w-full text-xs" aria-label={t("usersPage.jobTitle")}>
                        <SelectValue placeholder={t("presence.noJobTitle")} />
                      </SelectTrigger>
                      <SelectContent className="max-h-72">
                        <SelectItem value={NONE}>{t("presence.noJobTitle")}</SelectItem>
                        {JOB_TITLE_CATEGORIES.map((cat) => (
                          <div key={cat.key}>
                            <div className="px-2 pt-2 text-[11px] font-bold text-muted-foreground">{cat.labels[locale]}</div>
                            {cat.titles.map((title) => (
                              <SelectItem key={title.key} value={title.key} className="text-xs">{title.labels[locale]}</SelectItem>
                            ))}
                          </div>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  {r.userId !== myUserId && (
                    <div className="mt-2.5 flex flex-wrap gap-2">
                      {canResetPassword && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-9 gap-1.5 px-3 text-xs"
                          onClick={() => setResetRow(r)}
                        >
                          <KeyRound className="size-3.5 text-primary" aria-hidden />
                          {t("usersPage.resetPasswordTitle")}
                        </Button>
                      )}
                      <Button
                        variant={r.isActive ? "outline" : "secondary"}
                        size="sm"
                        className="h-9 gap-1.5 px-3 text-xs"
                        onClick={() => void toggleActive(r)}
                      >
                        {r.isActive ? <><Ban className="size-3.5 text-red-600" aria-hidden />{t("usersPage.deactivate")}</> : <><CheckCircle2 className="size-3.5 text-green-600" aria-hidden />{t("usersPage.activate")}</>}
                      </Button>
                      {canDelete && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-9 gap-1.5 px-3 text-xs text-red-600 hover:text-red-700"
                          onClick={() => setDeleteRow(r)}
                        >
                          <Trash2 className="size-3.5" aria-hidden />
                          {t("common.delete")}
                        </Button>
                      )}
                    </div>
                  )}
                  {r.userId === myUserId && <p className="mt-2 text-[11px] text-muted-foreground">{t("usersPage.you")}</p>}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* حوار الإنشاء */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{t("usersPage.createTitle")}</DialogTitle>
            <DialogDescription>{t("usersPage.createHint")}</DialogDescription>
          </DialogHeader>
          <form onSubmit={onCreate} className="flex flex-col gap-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="u-fullname">{t("usersPage.fullName")}</Label>
                <Input id="u-fullname" value={form.fullName} onChange={(e) => setForm((f) => ({ ...f, fullName: e.target.value }))} required minLength={2} maxLength={120} />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="u-email">{t("usersPage.email")}</Label>
                <Input id="u-email" type="email" dir="ltr" value={form.email} onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))} required />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="u-phone">{t("usersPage.phone")}</Label>
                <Input id="u-phone" dir="ltr" value={form.phone} onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))} maxLength={32} />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="u-role">{t("usersPage.role")}</Label>
                <Select value={form.role} onValueChange={(v) => setForm((f) => ({ ...f, role: v as typeof f.role }))}>
                  <SelectTrigger id="u-role"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {ROLE_KEYS.map((role) => (
                      <SelectItem key={role} value={role}>{t(roleLabelKey(role))}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex flex-col gap-1.5 sm:col-span-2">
                <Label htmlFor="u-title">{t("usersPage.jobTitle")}</Label>
                <Select value={form.jobTitleKey} onValueChange={(v) => setForm((f) => ({ ...f, jobTitleKey: v }))}>
                  <SelectTrigger id="u-title"><SelectValue placeholder={t("presence.noJobTitle")} /></SelectTrigger>
                  <SelectContent className="max-h-72">
                    <SelectItem value={NONE}>{t("presence.noJobTitle")}</SelectItem>
                    {JOB_TITLE_CATEGORIES.map((cat) => (
                      <div key={cat.key}>
                        <div className="px-2 pt-2 text-[11px] font-bold text-muted-foreground">{cat.labels[locale]}</div>
                        {cat.titles.map((title) => (
                          <SelectItem key={title.key} value={title.key} className="text-xs">{title.labels[locale]}</SelectItem>
                        ))}
                      </div>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex flex-col gap-1.5 sm:col-span-2">
                <Label htmlFor="u-password">{t("usersPage.password")}</Label>
                <Input id="u-password" type="text" dir="ltr" value={form.password} onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))} placeholder={t("usersPage.passwordPlaceholder")} minLength={8} maxLength={72} />
                <span className="text-[11px] text-muted-foreground">{t("usersPage.passwordHint")}</span>
              </div>
            </div>
            {/* أسماء بلغات أخرى — الاسم يتبع لغة الواجهة (بلاغ المالك 2026-10-23) */}
            <LocaleNamesFields form={formNames} setForm={setFormNames} disabled={saving} />
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setCreateOpen(false)}>{t("common.cancel")}</Button>
              <Button type="submit" disabled={saving} className="gap-2">
                {saving && <LoaderCircle className="size-4 animate-spin" aria-hidden />}
                {t("common.create")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* حوار التفويض */}
      <Dialog open={delegOpen} onOpenChange={setDelegOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("usersPage.grantDelegation")}</DialogTitle>
            <DialogDescription>{t("usersPage.delegationHint")}</DialogDescription>
          </DialogHeader>
          <form onSubmit={grantDelegation} className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="d-grantee">{t("usersPage.grantee")}</Label>
              <Select value={delegForm.granteeId} onValueChange={(v) => setDelegForm((f) => ({ ...f, granteeId: v }))}>
                <SelectTrigger id="d-grantee"><SelectValue placeholder={t("usersPage.grantee")} /></SelectTrigger>
                <SelectContent className="max-h-64">
                  {rows
                    .filter((r) => r.isActive && r.userId !== myUserId)
                    .map((r) => (
                      <SelectItem key={r.userId} value={r.userId}>{r.fullName} — {t(roleLabelKey(r.role))}</SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="d-perm">{t("usersPage.permission")}</Label>
              <Select value={delegForm.permission} onValueChange={(v) => setDelegForm((f) => ({ ...f, permission: v }))}>
                <SelectTrigger id="d-perm"><SelectValue placeholder={t("usersPage.permission")} /></SelectTrigger>
                <SelectContent className="max-h-64">
                  {delegable.map((p) => {
                    // (بلاغ المالك 2026-10-25): اسم مترجم + المفتاح التقني الصغير تحته —
                    // واضح للمالك ومحدد للتشخيص، بلا مفاتيح خام وحدها بعد الآن
                    const label = t(permissionLabelKey(p));
                    const translated = label.startsWith("permissions.") ? p : label;
                    return (
                      <SelectItem key={p} value={p} className="text-xs">
                        <span className="flex flex-col leading-tight">
                          <span>{translated}</span>
                          <span className="text-[10px] text-muted-foreground" dir="ltr">{p}</span>
                        </span>
                      </SelectItem>
                    );
                  })}
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="d-exp">{t("usersPage.expires")}</Label>
                <Input id="d-exp" dir="ltr" inputMode="numeric" value={delegForm.expiresInDays} onChange={(e) => setDelegForm((f) => ({ ...f, expiresInDays: e.target.value }))} placeholder={t("usersPage.noExpiry")} />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="d-note">{t("usersPage.note")}</Label>
                <Input id="d-note" value={delegForm.note} onChange={(e) => setDelegForm((f) => ({ ...f, note: e.target.value }))} maxLength={240} />
              </div>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setDelegOpen(false)}>{t("common.cancel")}</Button>
              <Button type="submit" disabled={delegSaving} className="gap-2">
                {delegSaving && <LoaderCircle className="size-4 animate-spin" aria-hidden />}
                <Check className="size-4" aria-hidden />
                {t("usersPage.grantDelegation")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      {/* حوار تغيير كلمة السر (بلاغ المالك 2026-10-25): users.password — السوبر أدمن
          بطبعه أو مفوَّض منه؛ الخادم يرفض تغيير كلمة سر سوبر أدمن من غير المالك ويبطل
          جلسات المستخدم فور التغيير. النتيجة تُعرض مرة واحدة فقط. */}
      <Dialog open={resetRow !== null} onOpenChange={(open) => { if (!open) setResetRow(null); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <KeyRound className="size-4 text-primary" aria-hidden />
              {t("usersPage.resetPasswordTitle")}
            </DialogTitle>
            <DialogDescription>{t("usersPage.resetPasswordDesc")}</DialogDescription>
          </DialogHeader>
          <form onSubmit={confirmResetPassword} className="flex flex-col gap-3">
            <div className="rounded-lg border border-border/70 bg-muted/40 p-3 text-sm">
              <p className="font-semibold">{resetRow?.fullName}</p>
              <p className="text-xs text-muted-foreground" dir="ltr">{resetRow?.email}</p>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="u-reset-password">{t("usersPage.resetPasswordLabel")}</Label>
              <Input id="u-reset-password" type="text" dir="ltr" minLength={8} maxLength={72} placeholder={t("usersPage.resetPasswordPlaceholder")} />
              <span className="text-[11px] text-muted-foreground">{t("usersPage.resetPasswordHint")}</span>
            </div>
            <p className="text-[11px] text-muted-foreground">{t("usersPage.passwordRules")}</p>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setResetRow(null)}>{t("common.cancel")}</Button>
              <Button type="submit" disabled={resetSaving} className="gap-2">
                {resetSaving && <LoaderCircle className="size-4 animate-spin" aria-hidden />}
                <KeyRound className="size-4" aria-hidden />
                {t("usersPage.resetPasswordOk")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      {/* حوار الحذف النهائي (أمر المالك 2026-10-23) */}
      <Dialog open={deleteRow !== null} onOpenChange={(open) => { if (!open) { setDeleteRow(null); setDeleteReason(""); } }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-red-600">{t("deleteDialog.userTitle")}</DialogTitle>
            <DialogDescription>{t("deleteDialog.userDesc")}</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3">
            <div className="rounded-lg border border-border/70 bg-muted/40 p-3 text-sm">
              <p className="font-semibold">{deleteRow?.fullName}</p>
              <p className="text-xs text-muted-foreground" dir="ltr">{deleteRow?.email}</p>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="u-delete-reason">{t("deleteDialog.reasonLabel")}</Label>
              <Input id="u-delete-reason" value={deleteReason} onChange={(e) => setDeleteReason(e.target.value)} maxLength={500} placeholder={t("deleteDialog.reasonPlaceholder")} />
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => { setDeleteRow(null); setDeleteReason(""); }}>{t("common.cancel")}</Button>
            <Button type="button" variant="destructive" disabled={deleting} className="gap-2" onClick={() => void confirmDelete()}>
              {deleting && <LoaderCircle className="size-4 animate-spin" aria-hidden />}
              <Trash2 className="size-4" aria-hidden />
              {t("common.confirmDelete")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

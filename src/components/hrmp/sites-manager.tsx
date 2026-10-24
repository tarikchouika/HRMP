"use client";

// HRMP — مدير المواقع (المرحلة 2 — معيار القبول): قائمة + خريطة بدوائر النطاق + إنشاء/تعديل بانتقاء جغرافي
// الأمان: الصلاحية تُفحص في الخادم (API) — هذه الواجهة عرض فقط
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import dynamic from "next/dynamic";
import { MapPin, Plus, Pencil, Archive, ArchiveRestore, Crosshair, Search, LoaderCircle, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { useI18n } from "@/i18n/provider";
import { LocaleNamesFields, EMPTY_LOCALE_NAMES, localeNamesFromRow, localeNamesBody } from "@/components/hrmp/locale-names-fields";
import { LocaleAddressesFields, EMPTY_LOCALE_ADDRESSES, localeAddressesFromRow, localeAddressesBody } from "@/components/hrmp/locale-addresses-fields";
import { cn } from "@/lib/utils";
import { RADIUS_MIN_M, RADIUS_MAX_M, RADIUS_DEFAULT_M } from "@/lib/organization";
import { PageHeader, StatusBadge, ConfirmAction, ListState, formatDate, apiRequest, apiErrorMessage } from "@/components/hrmp/org-bits";

// Leaflet يحتاج window — تحميل ديناميكي بلا SSR
const SiteMap = dynamic(() => import("@/components/hrmp/site-map").then((m) => m.SiteMap), {
  ssr: false,
  loading: () => <div className="h-[380px] w-full animate-pulse rounded-xl bg-muted/40" />,
});

type SiteRow = {
  baseName?: string;
  names?: string | null;
  id: string;
  name: string;
  address: string | null;
  baseAddress?: string | null;
  addresses?: string | null;
  latitude: number;
  longitude: number;
  radiusM: number;
  status: string;
  createdAt: string;
  branch: { id: string; name: string } | null;
  project: { id: string; name: string } | null;
};

type Option = { id: string; name: string };

type SiteForm = {
  name: string;
  address: string;
  branchId: string; // "" = بدون
  projectId: string;
  latitude: string;
  longitude: string;
  radiusM: number;
  namesAr: string;
  namesFr: string;
  namesEn: string;
  namesEs: string;
  addrAr: string;
  addrFr: string;
  addrEn: string;
  addrEs: string;
};

const EMPTY_FORM: SiteForm = {
  ...EMPTY_LOCALE_NAMES,
  ...EMPTY_LOCALE_ADDRESSES,
  name: "",
  address: "",
  branchId: "none", // Radix Select لا يقبل قيمة فارغة — none تعني «بدون»
  projectId: "none",
  latitude: "",
  longitude: "",
  radiusM: RADIUS_DEFAULT_M,
};

export function SitesManager({ canDelete = false }: { canDelete?: boolean }) {
  const { t, locale } = useI18n();
  const { toast } = useToast();

  const [sites, setSites] = useState<SiteRow[]>([]);
  const [branches, setBranches] = useState<Option[]>([]);
  const [projects, setProjects] = useState<Option[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const [q, setQ] = useState("");
  const [statusFilter, setStatusFilter] = useState<"active" | "archived" | "all">("active");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // حوار الإنشاء/التعديل
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<SiteForm>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const params = new URLSearchParams();
      if (statusFilter !== "all") params.set("status", statusFilter);
      if (q.trim()) params.set("q", q.trim());
      const data = await apiRequest<{ sites: SiteRow[] }>(`/api/sites?${params.toString()}`);
      setSites(data.sites);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [statusFilter, q]);

  // تحميل المواقع + خيارات الفروع والمشاريع (للنماذج)
  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void apiRequest<{ branches: { id: string; name: string; status: string }[] }>("/api/branches")
      .then((d) => setBranches(d.branches.filter((b) => b.status === "active").map((b) => ({ id: b.id, name: b.name }))))
      .catch(() => setBranches([]));
    void apiRequest<{ projects: { id: string; name: string; status: string }[] }>("/api/projects")
      .then((d) => setProjects(d.projects.filter((p) => p.status === "active").map((p) => ({ id: p.id, name: p.name }))))
      .catch(() => setProjects([]));
  }, [dialogOpen]); // إعادة الجلب عند فتح الحوار لتحديث الخيارات

  // بحث مؤجّل
  useEffect(() => {
    const timer = setTimeout(() => void load(), 350);
    return () => clearTimeout(timer);
  }, [q]);

  const mapSites = useMemo(
    () =>
      sites.map((s) => ({
        id: s.id,
        name: s.name,
        address: s.address,
        latitude: s.latitude,
        longitude: s.longitude,
        radiusM: s.radiusM,
        status: s.status,
        branchName: s.branch?.name ?? null,
        projectName: s.project?.name ?? null,
      })),
    [sites]
  );

  function openCreate() {
    setEditingId(null);
    setForm(EMPTY_FORM);
    setDialogOpen(true);
  }

  function openEdit(site: SiteRow) {
    setEditingId(site.id);
    setForm({
      ...localeNamesFromRow(site),
      ...localeAddressesFromRow(site),
      name: site.baseName ?? site.name,
      // العنوان الأساسي من baseAddress (لا من العرض المترجم) كي لا تتلوث النماذج بلغة الواجهة
      address: site.baseAddress ?? site.address ?? "",
      branchId: site.branch?.id ?? "none",
      projectId: site.project?.id ?? "none",
      latitude: String(site.latitude),
      longitude: String(site.longitude),
      radiusM: site.radiusM,
    });
    setDialogOpen(true);
  }

  function pickOnMap(lat: number, lng: number) {
    setForm((f) => ({ ...f, latitude: String(lat), longitude: String(lng) }));
  }

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (saving) return;

    const latitude = Number.parseFloat(form.latitude);
    const longitude = Number.parseFloat(form.longitude);
    const invalid =
      form.name.trim().length < 2 ||
      !Number.isFinite(latitude) ||
      latitude < -90 ||
      latitude > 90 ||
      !Number.isFinite(longitude) ||
      longitude < -180 ||
      longitude > 180 ||
      !Number.isInteger(form.radiusM) ||
      form.radiusM < RADIUS_MIN_M ||
      form.radiusM > RADIUS_MAX_M;
    if (invalid) {
      toast({ variant: "destructive", description: t("common.invalidInput") });
      return;
    }

    const body = JSON.stringify({
      name: form.name.trim(),
      names: localeNamesBody(form),
      address: form.address.trim(),
      addresses: localeAddressesBody(form),
      latitude,
      longitude,
      radiusM: form.radiusM,
      branchId: form.branchId === "none" ? "" : form.branchId,
      projectId: form.projectId === "none" ? "" : form.projectId,
    });

    setSaving(true);
    try {
      if (editingId) {
        await apiRequest(`/api/sites/${editingId}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body });
        toast({ description: t("sites.updated") });
      } else {
        await apiRequest("/api/sites", { method: "POST", headers: { "Content-Type": "application/json" }, body });
        toast({ description: t("sites.created") });
      }
      setDialogOpen(false);
      await load();
    } catch (err) {
      toast({ variant: "destructive", description: apiErrorMessage(t, err) });
    } finally {
      setSaving(false);
    }
  }

  async function onArchive(site: SiteRow) {
    try {
      await apiRequest(`/api/sites/${site.id}`, { method: "DELETE" });
      toast({ description: t("sites.archived") });
    } catch (err) {
      toast({ variant: "destructive", description: apiErrorMessage(t, err) });
    }
    await load();
  }

  /** الحذف النهائي (?purge=1) — data.delete؛ حرّاس السلامة في الخادم ترشد عند الرفض */
  async function onPurge(site: SiteRow) {
    try {
      await apiRequest(`/api/sites/${site.id}?purge=1`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: null }),
      });
      toast({ description: t("sites.deleted") });
    } catch (err) {
      toast({ variant: "destructive", description: apiErrorMessage(t, err) });
    }
    await load();
  }

  async function onRestore(site: SiteRow) {
    try {
      await apiRequest(`/api/sites/${site.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "active" }),
      });
      toast({ description: t("sites.restored") });
    } catch (err) {
      toast({ variant: "destructive", description: apiErrorMessage(t, err) });
    }
    await load();
  }

  // معاينة النطاق في حوار الإنشاء/التعديل
  const pickerLat = Number.parseFloat(form.latitude);
  const pickerLng = Number.parseFloat(form.longitude);

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6">
      <PageHeader title={t("sites.title")} subtitle={t("sites.subtitle")}>
        <Button onClick={openCreate} className="gap-2 font-bold">
          <Plus className="size-4" aria-hidden />
          {t("sites.createTitle")}
        </Button>
      </PageHeader>

      {/* أدوات التصفية */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-52 flex-1">
          <Search className="pointer-events-none absolute inset-y-0 start-3 my-auto size-4 text-muted-foreground" aria-hidden />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t("common.search")}
            className="ps-9"
            aria-label={t("common.search")}
          />
        </div>
        <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v as typeof statusFilter)}>
          <SelectTrigger className="w-40" aria-label={t("common.status")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="active">{t("common.active")}</SelectItem>
            <SelectItem value="archived">{t("common.archived")}</SelectItem>
            <SelectItem value="all">{t("common.showArchived")}</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* الخريطة */}
      <Card className="overflow-hidden border-border/70 p-0">
        <CardContent className="p-4">
          {loading ? (
            <div className="h-[380px] w-full animate-pulse rounded-xl bg-muted/40" />
          ) : mapSites.length === 0 ? (
            <div className="flex h-[380px] items-center justify-center rounded-xl border border-dashed border-border text-sm text-muted-foreground">
              {t("map.empty")}
            </div>
          ) : (
            <SiteMap
              sites={mapSites}
              selectedId={selectedId}
              onSelect={setSelectedId}
              className="h-[380px] w-full"
            />
          )}
        </CardContent>
      </Card>

      {/* القائمة */}
      <Card className="border-border/70">
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-base font-bold">
            <MapPin className="size-4 text-primary" aria-hidden />
            {t("sites.title")}
            <Badge variant="secondary" className="ms-1 tabular-nums">{sites.length}</Badge>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <ListState loading={loading && sites.length === 0} error={error} empty={!error && sites.length === 0} onRetry={() => void load()} />
          {!loading && !error && sites.length > 0 && (
            <div className="max-h-96 overflow-y-auto rounded-lg border border-border/60">
              <Table>
                <TableHeader className="sticky top-0 bg-muted/95 backdrop-blur">
                  <TableRow>
                    <TableHead className="text-xs">{t("common.name")}</TableHead>
                    <TableHead className="text-xs">{t("sites.branch")}</TableHead>
                    <TableHead className="text-xs">{t("sites.project")}</TableHead>
                    <TableHead className="text-xs">{t("sites.coordinates")}</TableHead>
                    <TableHead className="text-xs">{t("sites.radius")}</TableHead>
                    <TableHead className="text-xs">{t("common.status")}</TableHead>
                    <TableHead className="text-xs">{t("common.actions")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sites.map((site) => (
                    <TableRow
                      key={site.id}
                      className={cn("cursor-pointer", selectedId === site.id && "bg-muted/60")}
                      onClick={() => setSelectedId(site.id)}
                    >
                      <TableCell>
                        <p className="font-semibold">{site.name}</p>
                        {site.address && <p className="text-xs text-muted-foreground">{site.address}</p>}
                      </TableCell>
                      <TableCell className="text-xs">{site.branch?.name ?? "—"}</TableCell>
                      <TableCell className="text-xs">{site.project?.name ?? "—"}</TableCell>
                      <TableCell className="font-mono text-xs tabular-nums" dir="ltr">
                        {site.latitude.toFixed(6)}, {site.longitude.toFixed(6)}
                      </TableCell>
                      <TableCell className="text-xs tabular-nums" dir="ltr">{site.radiusM} m</TableCell>
                      <TableCell><StatusBadge status={site.status} /></TableCell>
                      <TableCell onClick={(e) => e.stopPropagation()}>
                        <div className="flex items-center gap-1">
                          <Button variant="ghost" size="icon" className="size-8" onClick={() => setSelectedId(site.id)} aria-label={t("map.locate")}>
                            <Crosshair className="size-4" aria-hidden />
                          </Button>
                          <Button variant="ghost" size="icon" className="size-8" onClick={() => openEdit(site)} aria-label={t("common.edit")}>
                            <Pencil className="size-4" aria-hidden />
                          </Button>
                          {site.status === "active" ? (
                            <ConfirmAction
                              triggerLabel={<><Archive className="size-4" aria-hidden />{t("common.archive")}</>}
                              triggerClassName="h-8 gap-1.5 px-2 text-xs text-destructive hover:text-destructive"
                              title={t("sites.title")}
                              description={t("sites.confirmArchive")}
                              confirmLabel={t("common.archive")}
                              onConfirm={() => onArchive(site)}
                            />
                          ) : (
                            <Button variant="ghost" size="sm" className="h-8 gap-1.5 px-2 text-xs" onClick={() => void onRestore(site)}>
                              <ArchiveRestore className="size-4" aria-hidden />
                              {t("common.restore")}
                            </Button>
                          )}
                          {canDelete && (
                            <ConfirmAction
                              triggerLabel={<Trash2 className="size-4" aria-hidden />}
                              triggerClassName="h-8 gap-1.5 px-2 text-xs text-destructive hover:text-destructive"
                              title={t("deleteDialog.siteTitle")}
                              description={t("deleteDialog.siteDesc")}
                              confirmLabel={t("common.confirmDelete")}
                              onConfirm={() => onPurge(site)}
                            />
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* حوار الإنشاء/التعديل مع الخريطة */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{editingId ? t("sites.editTitle") : t("sites.createTitle")}</DialogTitle>
            <DialogDescription>{t("sites.pickHint")}</DialogDescription>
          </DialogHeader>

          <form onSubmit={onSubmit} className="flex flex-col gap-4">
            {/* خريطة الانتقاء */}
            <SiteMap
              sites={[]}
              picker={{
                latitude: Number.isFinite(pickerLat) ? pickerLat : null,
                longitude: Number.isFinite(pickerLng) ? pickerLng : null,
                radiusM: form.radiusM,
                onPick: pickOnMap,
              }}
              className="h-56 w-full"
              center={
                Number.isFinite(pickerLat) && Number.isFinite(pickerLng)
                  ? [pickerLat, pickerLng]
                  : undefined
              }
              zoom={Number.isFinite(pickerLat) ? 15 : undefined}
            />

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="flex flex-col gap-2 sm:col-span-2">
                <Label htmlFor="site-name">{t("common.name")}</Label>
                <Input
                  id="site-name"
                  value={form.name}
                  onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                  required
                  minLength={2}
                  maxLength={120}
                  disabled={saving}
                />
              </div>

              <LocaleNamesFields form={form} setForm={setForm} disabled={saving} />
              {/* العنوان بلغات أخرى — يتبع لغة الواجهة (بلاغ المالك 2026-10-23) */}
              <LocaleAddressesFields form={form} setForm={setForm} disabled={saving} />

              <div className="flex flex-col gap-2 sm:col-span-2">
                <Label htmlFor="site-address">{t("common.address")}</Label>
                <Input
                  id="site-address"
                  value={form.address}
                  onChange={(e) => setForm((f) => ({ ...f, address: e.target.value }))}
                  maxLength={240}
                  disabled={saving}
                />
              </div>

              <div className="flex flex-col gap-2">
                <Label htmlFor="site-branch">{t("sites.branch")}</Label>
                <Select value={form.branchId} onValueChange={(v) => setForm((f) => ({ ...f, branchId: v }))}>
                  <SelectTrigger id="site-branch">
                    <SelectValue placeholder={t("sites.branch")} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">{t("sites.noBranch")}</SelectItem>
                    {branches.map((b) => (
                      <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="flex flex-col gap-2">
                <Label htmlFor="site-project">{t("sites.project")}</Label>
                <Select value={form.projectId} onValueChange={(v) => setForm((f) => ({ ...f, projectId: v }))}>
                  <SelectTrigger id="site-project">
                    <SelectValue placeholder={t("sites.project")} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">{t("sites.noProject")}</SelectItem>
                    {projects.map((p) => (
                      <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="flex flex-col gap-2">
                <Label htmlFor="site-lat">{t("sites.latitude")}</Label>
                <Input
                  id="site-lat"
                  type="number"
                  step="any"
                  min={-90}
                  max={90}
                  value={form.latitude}
                  onChange={(e) => setForm((f) => ({ ...f, latitude: e.target.value }))}
                  dir="ltr"
                  required
                  disabled={saving}
                />
              </div>

              <div className="flex flex-col gap-2">
                <Label htmlFor="site-lng">{t("sites.longitude")}</Label>
                <Input
                  id="site-lng"
                  type="number"
                  step="any"
                  min={-180}
                  max={180}
                  value={form.longitude}
                  onChange={(e) => setForm((f) => ({ ...f, longitude: e.target.value }))}
                  dir="ltr"
                  required
                  disabled={saving}
                />
              </div>

              <div className="flex flex-col gap-2 sm:col-span-2">
                <div className="flex items-center justify-between">
                  <Label htmlFor="site-radius">{t("sites.radius")}</Label>
                  <span className="text-xs tabular-nums text-muted-foreground" dir="ltr">{form.radiusM} m</span>
                </div>
                <Slider
                  value={[form.radiusM]}
                  onValueChange={(v) => setForm((f) => ({ ...f, radiusM: v[0] ?? f.radiusM }))}
                  min={RADIUS_MIN_M}
                  max={500}
                  step={5}
                  disabled={saving}
                  aria-label={t("sites.radius")}
                />
                <Input
                  id="site-radius"
                  type="number"
                  min={RADIUS_MIN_M}
                  max={RADIUS_MAX_M}
                  step={1}
                  value={form.radiusM}
                  onChange={(e) => setForm((f) => ({ ...f, radiusM: Number.parseInt(e.target.value, 10) || 0 }))}
                  dir="ltr"
                  disabled={saving}
                />
                <p className="text-xs text-muted-foreground">{t("sites.radiusHint")}</p>
              </div>
            </div>

            <DialogFooter>
              <Button type="submit" disabled={saving} className="gap-2 font-bold">
                {saving && <LoaderCircle className="size-4 animate-spin" aria-hidden />}
                {saving ? t("common.saving") : t("common.save")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

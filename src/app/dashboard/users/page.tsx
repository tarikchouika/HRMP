import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { ShieldAlert } from "lucide-react";
import { PageHeader } from "@/components/hrmp/org-bits";
import { getSession } from "@/lib/auth/session";
import { roleHas } from "@/lib/rbac";
import { hasPermission } from "@/lib/delegations";
import { readLocaleCookie, resolveLocale } from "@/i18n/config";
import { getDictionary, tServer } from "@/i18n/get-dictionary";
import { UsersManager } from "@/components/hrmp/users-manager";

export async function generateMetadata(): Promise<Metadata> {
  const store = await cookies();
  const dict = getDictionary(resolveLocale(readLocaleCookie(store)));
  return { title: tServer(dict, "usersPage.title") };
}

export default async function UsersPage() {
  const session = await getSession();
  if (!session) redirect("/login");

  const store = await cookies();
  const locale = resolveLocale(readLocaleCookie(store));
  const dict = getDictionary(locale);

  // الدخول: users.manage (سوبر/أدمن بطبعهما أو تفويض) — إنشاء الحسابات أضيق (users.create)
  const manage =
    roleHas(session.role, "users.manage") || (await hasPermission(session, "users.manage"));
  if (!manage) {
    return (
      <div className="mx-auto flex w-full max-w-2xl flex-col items-center gap-3 py-16 text-center">
        <ShieldAlert className="size-10 text-muted-foreground" aria-hidden />
        <p className="text-sm font-medium text-muted-foreground">{tServer(dict, "common.forbidden")}</p>
      </div>
    );
  }

  const canCreate =
    session.role === "super_admin" || (await hasPermission(session, "users.create"));
  // الحذف النهائي: data.delete — السوبر بطبعه أو مفوَّض (أمر المالك 2026-10-23)
  const canDelete =
    session.role === "super_admin" || (await hasPermission(session, "data.delete"));

  // تغيير كلمات السر (بلاغ المالك 2026-10-25): users.password — السوبر أدمن بطبعه
  // أو مفوَّض (المفوَّض لا يغيّر كلمة سر سوبر أدمن — حارس في الخادم)
  const canResetPassword =
    session.role === "super_admin" || (await hasPermission(session, "users.password"));

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6">
      <PageHeader title={tServer(dict, "usersPage.title")} subtitle={tServer(dict, "usersPage.subtitle")} />
      <UsersManager
        canCreate={canCreate}
        isSuperAdmin={session.role === "super_admin"}
        myUserId={session.sub}
        canDelete={canDelete}
        canResetPassword={canResetPassword}
      />
    </div>
  );
}

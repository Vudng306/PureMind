"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { AdminGate, AdminLogin } from "@/components/admin-login";
import { useAuth } from "@/components/auth-provider";
import { Icon } from "@/components/icons";
import { LanguageToggle } from "@/components/language-toggle";
import { Alert, Spinner } from "@/components/ui";
import { ApiError } from "@/lib/api";
import { useMsg, useT } from "@/lib/i18n";
import { MSG } from "@/lib/messages";
import { useAccount } from "@/lib/queries";
import { supabase } from "@/lib/supabase";

const TABS = [
  { href: "/admin/users", label: "admin.tabUsers" },
  { href: "/admin/audit", label: "admin.tabAudit" },
] as const;

function signOut() {
  // FR-AUTH-04: network errors never block clearing the local session
  return supabase()
    .auth.signOut()
    .catch(() => supabase().auth.signOut({ scope: "local" }));
}

function FullScreenSpinner() {
  return (
    <div className="flex min-h-screen items-center justify-center">
      <Spinner />
    </div>
  );
}

/**
 * FR-ADM: the admin pages, apart from the reading app. Signed out, they show their own sign-in; signed in
 * with an account that is not an admin, they say so. Hiding them is a courtesy: the server refuses every
 * /api/admin request that does not come from an admin.
 */
export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const t = useT();
  const msg = useMsg();
  const router = useRouter();
  const pathname = usePathname();
  const { session, loading } = useAuth();
  const { data: user, error, isPending } = useAccount();
  const [lockedOut, setLockedOut] = useState(false);

  // FR-ADM-03: a locked account is refused by the API; sign it out and say why on the sign-in card.
  useEffect(() => {
    if (!(error instanceof ApiError) || error.status !== 403) return;
    setLockedOut(true);
    void signOut();
  }, [error]);

  if (loading) return <FullScreenSpinner />;
  if (!session) return <AdminLogin initialError={lockedOut ? MSG["MSG-ACC-DISABLED"] : null} />;
  if (isPending) return <FullScreenSpinner />;

  if (user?.role !== "admin") {
    return (
      <AdminGate>
        <Alert>{error && !(error instanceof ApiError && error.status === 403) ? error.message : msg("MSG-ADM-FORBIDDEN")}</Alert>
        {user && <p className="text-sm leading-relaxed text-body">{t("admin.signedInAs", { email: user.email })}</p>}
        <div className="flex flex-wrap gap-2.5">
          <button type="button" className="btn-primary" onClick={() => void signOut()}>
            {t("admin.switchAccount")}
          </button>
          <Link href="/library" className="btn-outline">
            {t("admin.backToApp")}
          </Link>
        </div>
      </AdminGate>
    );
  }

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-20 border-b border-line bg-bg">
        <div className="flex h-[64px] items-center gap-3 px-4 sm:gap-6 sm:px-10">
          <Link href="/admin/users" className="flex items-baseline gap-2">
            <span className="font-serif text-[22px] font-semibold">PureMind</span>
            <span className="eyebrow">{t("admin.title").toUpperCase()}</span>
          </Link>
          <nav className="hidden gap-1 sm:flex" aria-label={t("admin.tabsAria")}>
            {TABS.map((tab) => {
              const active = pathname.startsWith(tab.href);
              return (
                <Link
                  key={tab.href}
                  href={tab.href}
                  aria-current={active ? "page" : undefined}
                  className={`flex h-10 items-center rounded-full px-4 text-[15px] transition-colors ${
                    active ? "bg-ink font-semibold text-bg" : "text-ink hover:bg-soft"
                  }`}
                >
                  {t(tab.label)}
                </Link>
              );
            })}
          </nav>
          <span className="flex-1" />
          <span className="hidden truncate text-sm text-muted md:inline">{user.email}</span>
          <Link href="/library" className="btn-ghost hidden px-3 lg:inline-flex">
            {t("admin.backToApp")}
          </Link>
          <LanguageToggle />
          <button
            type="button"
            className="icon-btn"
            aria-label={t("settings.signOut")}
            title={t("settings.signOut")}
            onClick={() => void signOut().then(() => router.replace("/admin"))}
          >
            <Icon name="logout" />
          </button>
        </div>
        <nav className="flex gap-1 px-4 pb-3 sm:hidden" aria-label={t("admin.tabsAria")}>
          {TABS.map((tab) => (
            <Link key={tab.href} href={tab.href} className="chip h-9" aria-pressed={pathname.startsWith(tab.href)}>
              {t(tab.label)}
            </Link>
          ))}
        </nav>
      </header>

      <main className="px-4 pb-[72px] pt-8 sm:px-10">
        <div className="mx-auto flex max-w-[1180px] flex-col gap-6">
          <h1 className="sr-only">{t("admin.title")}</h1>
          <p className="text-[13px] leading-normal text-muted">{t("admin.privacyNote")}</p>
          {children}
        </div>
      </main>
    </div>
  );
}

"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { AdminGate, AdminLogin } from "@/components/admin-login";
import { useAuth } from "@/components/auth-provider";
import { Icon } from "@/components/icons";
import { LanguageToggle } from "@/components/language-toggle";
import { Alert, Spinner, Wordmark } from "@/components/ui";
import { ApiError } from "@/lib/api";
import { CATALOG, COMMUNITY } from "@/lib/features";
import { useMsg, useT } from "@/lib/i18n";
import { MSG } from "@/lib/messages";
import { useAccount } from "@/lib/queries";
import { supabase } from "@/lib/supabase";

const ALL_TABS = [
  { href: "/admin/traffic", label: "admin.tabTraffic", icon: "chart" },
  { href: "/admin/users", label: "admin.tabUsers", icon: "user" },
  { href: "/admin/articles", label: "admin.tabArticles", icon: "file" },
  { href: "/admin/posts", label: "admin.tabPosts", icon: "note" },
  { href: "/admin/crawl", label: "admin.tabCrawl", icon: "download" },
  { href: "/admin/audit", label: "admin.tabAudit", icon: "history" },
] as const;
// Pages for parts that are out of the interface (src/lib/features.ts) are left out of the menu.
const OFF: readonly string[] = [
  ...(COMMUNITY ? [] : ["/admin/posts"]),
  ...(CATALOG ? [] : ["/admin/articles", "/admin/crawl"]),
];
const TABS = ALL_TABS.filter((tab) => !OFF.includes(tab.href));

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
    <div className="app-backdrop min-h-screen lg:pl-[232px]">
      {/* On a wide screen the menu is a column down the left edge, as in the reading app. */}
      <aside className="glass fixed inset-y-0 left-0 z-30 hidden w-[232px] flex-col gap-5 overflow-y-auto border-r px-4 pb-5 lg:flex">
        <Link href="/admin/traffic" className="flex h-[64px] shrink-0 items-center rounded-[10px] px-1">
          <Wordmark />
        </Link>
        <span className="eyebrow px-3">{t("admin.title").toUpperCase()}</span>
        <nav className="flex flex-col gap-1" aria-label={t("admin.tabsAria")}>
          {TABS.map((tab) => {
            const active = pathname.startsWith(tab.href);
            return (
              <Link
                key={tab.href}
                href={tab.href}
                aria-current={active ? "page" : undefined}
                className={`flex h-11 items-center gap-3 rounded-xl px-3 text-[15px] font-medium transition-colors ${
                  active ? "bg-ink font-semibold text-bg" : "text-body hover:bg-soft hover:text-ink"
                }`}
              >
                <Icon name={tab.icon} size={19} />
                <span className="min-w-0 truncate">{t(tab.label)}</span>
              </Link>
            );
          })}
        </nav>
        <span className="flex-1" />
        <Link
          href="/library"
          className="flex h-11 shrink-0 items-center gap-3 rounded-xl px-3 text-[15px] font-medium text-body transition-colors hover:bg-soft hover:text-ink"
        >
          <Icon name="back" size={19} />
          <span className="min-w-0 truncate">{t("admin.backToApp")}</span>
        </Link>
      </aside>
      <header className="glass sticky top-0 z-20 border-b">
        <div className="flex h-[64px] items-center gap-3 px-4 sm:gap-6 sm:px-10">
          <Link href="/admin/traffic" className="flex items-center gap-2.5 lg:hidden">
            <Wordmark word="hidden sm:inline" />
            <span className="eyebrow">{t("admin.title").toUpperCase()}</span>
          </Link>
          <span className="flex-1" />
          <span className="hidden truncate text-sm text-muted md:inline">{user.email}</span>
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
        <nav className="flex gap-1 overflow-x-auto px-4 pb-3 [scrollbar-width:none] lg:hidden" aria-label={t("admin.tabsAria")}>
          {TABS.map((tab) => (
            <Link key={tab.href} href={tab.href} className="chip h-9 shrink-0" aria-pressed={pathname.startsWith(tab.href)}>
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

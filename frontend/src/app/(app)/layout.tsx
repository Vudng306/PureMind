"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";

import { AddDocumentDialog } from "@/components/add-document-dialog";
import { useAuth } from "@/components/auth-provider";
import { CommandPalette } from "@/components/command-palette";
import { Icon } from "@/components/icons";
import { LanguageToggle } from "@/components/language-toggle";
import { LocalDataImport } from "@/components/local-data-import";
import { PreferencesSync } from "@/components/preferences-sync";
import { TermsGate } from "@/components/terms-gate";
import { Spinner } from "@/components/ui";
import { UserMenu } from "@/components/user-menu";
import { ApiError } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { useAccount } from "@/lib/queries";
import { isSupabaseConfigured, supabase } from "@/lib/supabase";
import { useUi } from "@/lib/ui-store";

// Highlight và Tìm kiếm không nằm trên thanh này: highlight đọc ngay trong tài liệu, còn tìm kiếm
// đã có ô Ctrl K bên phải. Hai trang vẫn sống ở /highlights và /search. Cài đặt nằm trong menu ảnh
// đại diện, còn tùy chọn đọc thì ngay trong trình đọc. Bảng tin là một khu riêng: vào từ cái tag
// cạnh ô tìm kiếm, không phải một mục của thanh này.
const NAV = [
  { href: "/library", label: "nav.library", icon: "book" },
  { href: "/notebooks", label: "nav.notebooks", icon: "note" },
  { href: "/study", label: "nav.study", icon: "cards" },
  { href: "/explore", label: "nav.explore", icon: "compass" },
] as const;
// On a phone the dock holds all four, two on each side of the add button.
const DOCK = NAV;

function DockLink({ item, active, label }: { item: (typeof NAV)[number]; active: boolean; label: string }) {
  return (
    <Link
      href={item.href}
      aria-current={active ? "page" : undefined}
      className={`flex w-16 flex-col items-center gap-0.5 rounded-full py-1.5 text-[11px] transition-colors ${
        active ? "font-semibold text-ink" : "text-muted hover:text-ink"
      }`}
    >
      <span className={`grid h-8 w-11 place-items-center rounded-full ${active ? "bg-ink text-bg" : ""}`}>
        <Icon name={item.icon} size={19} />
      </span>
      {label}
    </Link>
  );
}

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const { session, loading } = useAuth();
  const { data: user, error: accountError } = useAccount();
  const { setAddOpen, setPaletteOpen } = useUi();
  const t = useT();

  // FR-AUTH-05 step 4
  useEffect(() => {
    if (!isSupabaseConfigured || (!loading && !session)) router.replace("/login");
  }, [loading, session, router]);

  // FR-ADM-03: a locked account is refused by the API; sign it out here and say why on the login page.
  useEffect(() => {
    if (!(accountError instanceof ApiError) || accountError.status !== 403) return;
    void supabase()
      .auth.signOut({ scope: "local" })
      .catch(() => undefined)
      .finally(() => router.replace("/login?disabled=1"));
  }, [accountError, router]);

  // Ctrl/Cmd+K opens quick search everywhere in the app.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen(true);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setPaletteOpen]);

  if (!isSupabaseConfigured || loading || !session) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Spinner />
      </div>
    );
  }

  // The terms come first: nothing of the app until the current version is accepted.
  if (user && !user.terms_accepted) return <TermsGate user={user} />;

  const overlays = (
    <>
      <PreferencesSync />
      <LocalDataImport />
      <CommandPalette />
      <AddDocumentDialog />
    </>
  );

  // The reader uses the full screen, and the feed is a place of its own with its own header.
  if (pathname.startsWith("/reader/") || pathname === "/feed") {
    return (
      <>
        {overlays}
        {children}
      </>
    );
  }

  const isActive = (href: string) => pathname === href || pathname.startsWith(`${href}/`);

  return (
    <div className="app-backdrop min-h-screen">
      {overlays}
      <header className="glass sticky top-0 z-20 border-b print:hidden">
        <div className="flex h-[68px] items-center gap-2 px-4 sm:gap-4 sm:px-10 xl:gap-6">
          <Link href="/library" className="font-serif font-semibold text-[22px] sm:text-[26px]">
            PureMind
          </Link>
          <nav aria-label={t("nav.aria")} className="glass hidden shrink-0 gap-1 rounded-full border p-1 lg:flex">
            {NAV.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                aria-current={isActive(item.href) ? "page" : undefined}
                className={`flex h-9 items-center rounded-full px-4 text-[15px] transition-colors ${
                  isActive(item.href) ? "bg-ink font-semibold text-bg" : "text-body hover:bg-soft hover:text-ink"
                }`}
              >
                {t(item.label)}
              </Link>
            ))}
          </nav>
          <span className="flex-1" />
          {/* Its name where the bar has room for it: not on a phone, nor beside the full nav before the search box shrinks. */}
          <Link
            href="/feed"
            aria-label={t("nav.feed")}
            className="glass icon-btn shrink-0 border sm:w-auto sm:gap-2 sm:px-4 sm:text-[15px] sm:font-medium lg:w-11 lg:px-0 xl:w-auto xl:px-4"
          >
            <Icon name="spark" />
            <span className="hidden sm:inline lg:hidden xl:inline">{t("nav.feed")}</span>
          </Link>
          <button
            type="button"
            onClick={() => setPaletteOpen(true)}
            className="glass hidden h-11 w-[320px] min-w-0 shrink items-center gap-2.5 rounded-full border pl-4 pr-3 text-[15px] text-muted transition-colors hover:text-ink xl:flex"
          >
            <Icon name="search" />
            <span className="min-w-0 flex-1 truncate text-left">{t("nav.searchPlaceholder")}</span>
            <kbd className="rounded-full border border-line px-2 py-0.5 font-sans text-xs">Ctrl K</kbd>
          </button>
          <button type="button" className="glass icon-btn border xl:hidden" aria-label={t("nav.quickSearch")} onClick={() => setPaletteOpen(true)}>
            <Icon name="search" />
          </button>
          <button type="button" className="btn-primary hidden shrink-0 pl-4 lg:inline-flex" onClick={() => setAddOpen(true)}>
            <Icon name="plus" />
            {t("nav.addDocument")}
          </button>
          <LanguageToggle className="glass rounded-full" />
          <UserMenu user={user} />
        </div>
      </header>

      <main className="px-4 pb-[120px] pt-6 sm:px-10 sm:pt-10 lg:pb-[72px] print:p-0">{children}</main>

      {/* The phone's dock: the pages within reach of a thumb, and adding a document in the middle. */}
      <nav
        aria-label={t("nav.ariaMobile")}
        className="glass fixed inset-x-3 bottom-3 z-30 mx-auto flex max-w-[440px] items-center justify-around rounded-full border px-2 py-1.5 shadow-pop lg:hidden print:hidden"
      >
        {DOCK.slice(0, 2).map((item) => (
          <DockLink key={item.href} item={item} active={isActive(item.href)} label={t(item.label)} />
        ))}
        <button
          type="button"
          onClick={() => setAddOpen(true)}
          aria-label={t("nav.addDocument")}
          className="-my-4 grid h-14 w-14 place-items-center rounded-full bg-accent text-on-accent shadow-pop ring-4 ring-bg"
        >
          <Icon name="plus" size={24} />
        </button>
        {DOCK.slice(2).map((item) => (
          <DockLink key={item.href} item={item} active={isActive(item.href)} label={t(item.label)} />
        ))}
      </nav>
    </div>
  );
}

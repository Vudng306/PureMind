"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";

import { AddDocumentDialog } from "@/components/add-document-dialog";
import { useAuth } from "@/components/auth-provider";
import { Avatar } from "@/components/avatar";
import { CommandPalette } from "@/components/command-palette";
import { Icon } from "@/components/icons";
import { LanguageToggle } from "@/components/language-toggle";
import { LocalDataImport } from "@/components/local-data-import";
import { PreferencesSync } from "@/components/preferences-sync";
import { Spinner } from "@/components/ui";
import { useT } from "@/lib/i18n";
import { useAccount } from "@/lib/queries";
import { isSupabaseConfigured } from "@/lib/supabase";
import { useUi } from "@/lib/ui-store";

// Highlight và Tìm kiếm không nằm trên thanh này: highlight đọc ngay trong tài liệu, còn tìm kiếm
// đã có ô Ctrl K bên phải. Hai trang vẫn sống ở /highlights và /search.
const NAV = [
  { href: "/library", label: "nav.library" },
  { href: "/notebooks", label: "nav.notebooks" },
  { href: "/settings", label: "nav.settings" },
] as const;

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const { session, loading } = useAuth();
  const { data: user } = useAccount();
  const { setAddOpen, setPaletteOpen } = useUi();
  const t = useT();

  // FR-AUTH-05 step 4
  useEffect(() => {
    if (!isSupabaseConfigured || (!loading && !session)) router.replace("/login");
  }, [loading, session, router]);

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

  const overlays = (
    <>
      <PreferencesSync />
      <LocalDataImport />
      <CommandPalette />
      <AddDocumentDialog />
    </>
  );

  // The reader uses the full screen.
  if (pathname.startsWith("/reader/")) {
    return (
      <>
        {overlays}
        {children}
      </>
    );
  }

  return (
    <div className="min-h-screen">
      {overlays}
      <header className="sticky top-0 z-20 border-b border-line bg-bg">
        <div className="flex h-[72px] items-center gap-3 px-4 sm:gap-7 sm:px-10">
          <Link href="/library" className="font-serif text-[22px] font-semibold sm:text-[26px]">
            PureMind
          </Link>
          <nav aria-label={t("nav.aria")} className="hidden gap-1 md:flex">
            {NAV.map((item) => {
              const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  className={`flex h-10 items-center rounded-full px-4 text-[15px] transition-colors ${
                    active ? "bg-ink font-semibold text-bg" : "text-ink hover:bg-soft"
                  }`}
                >
                  {t(item.label)}
                </Link>
              );
            })}
          </nav>
          <span className="flex-1" />
          <button
            type="button"
            onClick={() => setPaletteOpen(true)}
            className="hidden h-11 w-[340px] items-center gap-2.5 rounded-[10px] border border-field bg-surface pl-3.5 pr-3 text-[15px] text-muted transition-colors hover:border-accent lg:flex"
          >
            <Icon name="search" />
            <span className="flex-1 text-left">{t("nav.searchPlaceholder")}</span>
            <kbd className="rounded-[5px] border border-line px-1.5 py-0.5 font-sans text-xs">Ctrl K</kbd>
          </button>
          <button type="button" className="icon-btn lg:hidden" aria-label={t("nav.quickSearch")} onClick={() => setPaletteOpen(true)}>
            <Icon name="search" />
          </button>
          <button type="button" className="btn-primary pl-3.5" onClick={() => setAddOpen(true)}>
            <Icon name="plus" />
            <span className="hidden sm:inline">{t("nav.addDocument")}</span>
          </button>
          <LanguageToggle />
          <Link href="/settings" aria-label={t("nav.account")} className="rounded-full">
            {user ? (
              <Avatar user={user} size={44} />
            ) : (
              <span className="block h-11 w-11 rounded-full bg-soft" aria-hidden />
            )}
          </Link>
        </div>
        <nav aria-label={t("nav.ariaMobile")} className="flex gap-1 px-4 pb-3 md:hidden">
          {NAV.map((item) => (
            <Link key={item.href} href={item.href} className="chip h-9" aria-pressed={pathname.startsWith(item.href)}>
              {t(item.label)}
            </Link>
          ))}
        </nav>
      </header>

      <main className="px-4 pb-[72px] pt-8 sm:px-10 sm:pt-10">{children}</main>
    </div>
  );
}

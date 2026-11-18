"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";

import { AddDocumentDialog } from "@/components/add-document-dialog";
import { CommandPalette } from "@/components/command-palette";
import { Icon } from "@/components/icons";
import { LanguageToggle } from "@/components/language-toggle";
import { LocalDataImport } from "@/components/local-data-import";
import { PreferencesSync } from "@/components/preferences-sync";
import { Logo } from "@/components/ui";
import { UserMenu } from "@/components/user-menu";
import { ApiError } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { useAccount } from "@/lib/queries";
import { signInHref } from "@/lib/sign-in";
import { supabase } from "@/lib/supabase";
import { useUi } from "@/lib/ui-store";

// Highlight và Tìm kiếm không nằm trên thanh này: highlight đọc ngay trong tài liệu, còn tìm kiếm
// đã có ô Ctrl K bên phải. Hai trang vẫn sống ở /highlights và /search. Cài đặt nằm trong menu ảnh
// đại diện, còn tùy chọn đọc thì ngay trong trình đọc.
const PAGES = [
  { href: "/explore", label: "nav.explore", icon: "compass" },
  { href: "/library", label: "nav.library", icon: "book" },
  { href: "/notebooks", label: "nav.notebooks", icon: "note" },
] as const;
const NAV = PAGES;
// On a phone the dock holds all of them, around the add button.
const DOCK = [...NAV, { href: "/settings/account", label: "nav.account", icon: "gear" }] as const;
// What a visitor can see or be drawn to: the rest is the reader's own.
export const PUBLIC_NAV = NAV.filter((page) => page.href === "/explore");

const isActive = (pathname: string, href: string) => pathname === href || pathname.startsWith(`${href}/`);

export function MainNav({ items = NAV, className }: { items?: readonly (typeof NAV)[number][]; className: string }) {
  const pathname = usePathname();
  const t = useT();
  return (
    <nav aria-label={t("nav.aria")} className={`shrink-0 gap-1 rounded-full bg-soft p-1 ${className}`}>
      {items.map((item) => (
        <Link
          key={item.href}
          href={item.href}
          aria-current={isActive(pathname, item.href) ? "page" : undefined}
          className={`flex h-9 items-center rounded-full px-4 text-[15px] font-medium transition-colors ${
            isActive(pathname, item.href) ? "bg-ink font-semibold text-bg" : "text-body hover:bg-surface hover:text-ink"
          }`}
        >
          {t(item.label)}
        </Link>
      ))}
    </nav>
  );
}

/** The signed-in app's menu on a wide screen: a column down the left edge, one row per page. */
function SideNav() {
  const pathname = usePathname();
  const t = useT();
  return (
    <nav aria-label={t("nav.aria")} className="flex flex-col gap-1">
      {NAV.map((item) => {
        const active = isActive(pathname, item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            className={`flex h-11 items-center gap-3 rounded-xl px-3 text-[15px] font-medium transition-colors ${
              active ? "bg-ink font-semibold text-bg" : "text-body hover:bg-soft hover:text-ink"
            }`}
          >
            <Icon name={item.icon} size={19} />
            <span className="min-w-0 truncate">{t(item.label)}</span>
          </Link>
        );
      })}
    </nav>
  );
}

/** FR-ADM-03: a locked account is refused by the API; sign it out here and say why on the login page. */
export function useLockedOut() {
  const router = useRouter();
  const { error } = useAccount();

  useEffect(() => {
    if (!(error instanceof ApiError) || error.status !== 403) return;
    void supabase()
      .auth.signOut({ scope: "local" })
      .catch(() => undefined)
      .finally(() => router.replace("/login?disabled=1"));
  }, [error, router]);
}

function DockLink({ item, active, label }: { item: (typeof DOCK)[number]; active: boolean; label: string }) {
  return (
    <Link
      href={item.href}
      aria-current={active ? "page" : undefined}
      className={`flex min-w-0 flex-col items-center gap-0.5 rounded-full py-1.5 text-[10px] transition-colors ${
        active ? "font-semibold text-ink" : "text-muted hover:text-ink"
      }`}
    >
      <span className={`grid h-8 w-11 place-items-center rounded-full ${active ? "bg-ink text-bg" : ""}`}>
        <Icon name={item.icon} size={19} />
      </span>
      <span className="max-w-full truncate">{label}</span>
    </Link>
  );
}

/** What every signed-in page has, with or without the bar: quick search (Ctrl/Cmd+K), adding a document,
 * the preferences kept in sync. */
export function AppOverlays() {
  const { setPaletteOpen } = useUi();

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

  return (
    <>
      <PreferencesSync />
      <LocalDataImport />
      <CommandPalette />
      <AddDocumentDialog />
    </>
  );
}

/** The signed-in app's frame: the menu in a column on the left and a bar on top, or the bar and a dock on a
 * phone. Explore uses it too once signed in, though
 * it lives outside the app's pages because visitors may browse it. */
/** The pages a visitor can open without an account (Explore and the feed): what they can reach, and signing in,
 * which brings them back to the same page. */
export function PublicShell({ children, mainClassName = "px-4 pb-[72px] pt-6 sm:px-10 sm:pt-10" }: {
  children: React.ReactNode;
  mainClassName?: string;
}) {
  const pathname = usePathname();
  const t = useT();
  return (
    <div className="app-backdrop min-h-screen">
      <header className="glass sticky top-0 z-20 border-b print:hidden">
        <div className="flex h-[68px] items-center gap-2 px-4 sm:gap-4 sm:px-10 xl:gap-6">
          {/* On a narrow phone the two pages and signing in come first; the sign-in page has the language too. */}
          <div className="hidden min-[420px]:block">
            <Logo word="hidden min-[520px]:inline" />
          </div>
          <MainNav items={PUBLIC_NAV} className="flex" />
          <span className="flex-1" />
          <div className="hidden sm:block">
            <LanguageToggle />
          </div>
          <Link href={signInHref(pathname)} className="btn-primary h-11 shrink-0 px-3 sm:px-4">
            {t("explore.signIn")}
          </Link>
        </div>
      </header>
      <main className={mainClassName}>{children}</main>
    </div>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { data: user } = useAccount();
  const { setAddOpen, setPaletteOpen } = useUi();
  const t = useT();

  return (
    <div className="app-backdrop min-h-screen lg:pl-[232px] print:pl-0">
      <AppOverlays />
      <aside className="glass fixed inset-y-0 left-0 z-30 hidden w-[232px] flex-col gap-5 overflow-y-auto border-r px-4 pb-5 lg:flex print:hidden">
        <div className="flex h-[68px] shrink-0 items-center px-1">
          <Logo />
        </div>
        <button type="button" className="btn-primary shrink-0 justify-start pl-4" onClick={() => setAddOpen(true)}>
          <Icon name="plus" />
          {t("nav.addDocument")}
        </button>
        <SideNav />
      </aside>
      <header className="glass sticky top-0 z-20 border-b print:hidden">
        <div className="flex h-[68px] items-center gap-2 px-4 sm:gap-4 sm:px-10 xl:gap-6">
          <Logo className="lg:hidden" word="hidden sm:inline" />
          <span className="flex-1" />
          <button
            type="button"
            onClick={() => setPaletteOpen(true)}
            className="hidden h-11 w-[300px] min-w-0 shrink items-center gap-2.5 rounded-full border border-line bg-bg pl-4 pr-3 text-[15px] text-muted transition-colors hover:border-field hover:text-ink xl:flex"
          >
            <Icon name="search" />
            <span className="min-w-0 flex-1 truncate text-left">{t("nav.searchPlaceholder")}</span>
            <kbd className="rounded-full border border-line px-2 py-0.5 font-sans text-xs">Ctrl K</kbd>
          </button>
          <button type="button" className="glass icon-btn border xl:hidden" aria-label={t("nav.quickSearch")} onClick={() => setPaletteOpen(true)}>
            <Icon name="search" />
          </button>
          <LanguageToggle className="glass rounded-full" />
          <UserMenu user={user} />
        </div>
      </header>

      <main className="px-4 pb-[120px] pt-6 sm:px-10 sm:pt-10 lg:pb-[72px] print:p-0">{children}</main>

      {/* The phone's dock: the pages within reach of a thumb, and adding a document in the middle. */}
      <nav
        aria-label={t("nav.ariaMobile")}
        className="glass fixed inset-x-3 bottom-[max(12px,env(safe-area-inset-bottom))] z-30 mx-auto grid max-w-[440px] grid-cols-5 items-center rounded-full border px-2 py-1.5 shadow-pop lg:hidden print:hidden"
      >
        {DOCK.slice(0, 2).map((item) => (
          <DockLink key={item.href} item={item} active={isActive(pathname, item.href)} label={t(item.href === "/settings/account" ? "nav.accountMobile" : item.href === "/notebooks" ? "nav.notebooksMobile" : item.label)} />
        ))}
        <button
          type="button"
          onClick={() => setAddOpen(true)}
          aria-label={t("nav.addDocument")}
          className="-my-4 grid h-12 w-12 justify-self-center place-items-center rounded-full bg-accent text-on-accent shadow-pop ring-4 ring-bg"
        >
          <Icon name="plus" size={24} />
        </button>
        {DOCK.slice(2).map((item) => (
          <DockLink key={item.href} item={item} active={isActive(pathname, item.href)} label={t(item.href === "/settings/account" ? "nav.accountMobile" : item.href === "/notebooks" ? "nav.notebooksMobile" : item.label)} />
        ))}
      </nav>
    </div>
  );
}

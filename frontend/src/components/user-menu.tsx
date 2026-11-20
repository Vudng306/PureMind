"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { Avatar } from "@/components/avatar";
import { ActionSheet, type SheetAction } from "@/components/bottom-sheet";
import { Icon, type IconName } from "@/components/icons";
import { LanguageToggle } from "@/components/language-toggle";
import { useT, type Key } from "@/lib/i18n";
import { usePreferences } from "@/lib/preferences";
import { supabase } from "@/lib/supabase";
import type { AppTheme, User } from "@/lib/types";

const THEMES: [AppTheme, Key, IconName][] = [
  ["light", "settings.themeLight", "sun"],
  ["dark", "settings.themeDark", "moon"],
];

/** What can be done from the account entry, in the avatar's menu and in the phone's sheet alike. */
function useAccountActions(user?: User): SheetAction[] {
  const t = useT();
  const router = useRouter();

  async function signOut() {
    // FR-AUTH-04: network errors never block clearing the local session
    await supabase()
      .auth.signOut()
      .catch(() => supabase().auth.signOut({ scope: "local" }));
    router.replace("/login");
  }

  return [
    { key: "account", label: t("settings.tabAccount"), icon: "user", href: "/settings?tab=account" },
    { key: "reading", label: t("settings.readingOptions"), icon: "gear", href: "/settings" },
    ...(user?.role === "admin" ? [{ key: "admin", label: t("admin.menu"), icon: "shield" as const, href: "/admin" }] : []),
    { key: "signOut", label: t("settings.signOut"), icon: "logout", onSelect: () => void signOut(), danger: true },
  ];
}

function AccountName({ user }: { user: User }) {
  return (
    <div className="flex flex-col gap-0.5 px-2.5 py-2">
      <span className="truncate text-sm font-semibold text-ink">{user.display_name || user.email}</span>
      {user.display_name && <span className="truncate text-[13px] text-muted">{user.email}</span>}
    </div>
  );
}

/** Day or night, right where the account lives, so the toolbar needs no button of its own. */
function ThemePicker() {
  const t = useT();
  const prefs = usePreferences();
  return (
    <div className="flex items-center gap-1 border-y border-line px-1 py-1.5" role="radiogroup" aria-label={t("settings.theme")}>
      {THEMES.map(([value, label, icon]) => (
        <button
          key={value}
          type="button"
          role="radio"
          aria-checked={prefs.theme === value}
          onClick={() => prefs.set({ theme: value })}
          className={`flex h-10 flex-1 items-center justify-center gap-2 rounded-[9px] text-sm transition-colors ${
            prefs.theme === value ? "bg-ink font-semibold text-bg" : "text-ink hover:bg-soft"
          }`}
        >
          <Icon name={icon} size={16} />
          {t(label)}
        </button>
      ))}
    </div>
  );
}

/** The account entry of the phone's dock: the avatar's menu, within reach of a thumb, with the language too. */
export function AccountSheet({ user, open, onClose }: { user?: User; open: boolean; onClose: () => void }) {
  const t = useT();
  const actions = useAccountActions(user);
  return (
    <ActionSheet open={open} onClose={onClose} label={t("nav.account")} actions={actions}>
      {user && <AccountName user={user} />}
      <ThemePicker />
      <div className="my-1 flex min-h-12 items-center justify-between gap-3 border-b border-line px-2.5 pb-1 text-[15px] text-ink">
        {t("nav.language")}
        <LanguageToggle />
      </div>
    </ActionSheet>
  );
}

/**
 * Everything about the account hangs off the avatar, so the toolbar keeps one entry instead of a
 * "Settings" tab next to the reading pages (UI-10).
 */
export function UserMenu({ user }: { user?: User }) {
  const t = useT();
  const actions = useAccountActions(user);
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const item = "flex h-11 items-center gap-2.5 rounded-[9px] px-2.5 text-left text-sm text-ink hover:bg-soft";

  return (
    <div ref={box} className="relative">
      <button
        type="button"
        aria-label={t("nav.account")}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="block rounded-full"
      >
        {user ? <Avatar user={user} size={44} /> : <span className="block h-11 w-11 rounded-full bg-soft" aria-hidden />}
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 top-[52px] z-30 flex w-[248px] flex-col gap-0.5 rounded-[14px] border border-line bg-surface p-1.5 shadow-float"
        >
          {user && <AccountName user={user} />}
          <ThemePicker />
          {actions.map((action) =>
            action.href ? (
              <Link key={action.key} href={action.href} role="menuitem" className={item} onClick={() => setOpen(false)}>
                <Icon name={action.icon} />
                {action.label}
              </Link>
            ) : (
              <button
                key={action.key}
                type="button"
                role="menuitem"
                onClick={action.onSelect}
                className={`${item} border-t border-line text-danger`}
              >
                <Icon name={action.icon} />
                {action.label}
              </button>
            ),
          )}
        </div>
      )}
    </div>
  );
}

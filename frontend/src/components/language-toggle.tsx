"use client";

import { LANG_LABEL, LANG_SHORT, useT } from "@/lib/i18n";
import { usePreferences } from "@/lib/preferences";
import type { Lang } from "@/lib/types";

/**
 * FR-ACC-04: two languages, so one button is enough — it shows the one you would switch to, and the
 * label of the *other* language is written in that language so it reads to whoever needs it.
 */
export function LanguageToggle({ className = "" }: { className?: string }) {
  const t = useT();
  const language = usePreferences((s) => s.language);
  const set = usePreferences((s) => s.set);
  const other: Lang = language === "vi" ? "en" : "vi";

  return (
    <button
      type="button"
      onClick={() => set({ language: other })}
      title={LANG_LABEL[other]}
      aria-label={`${t("nav.language")}: ${LANG_LABEL[other]}`}
      className={`flex h-11 items-center rounded-[10px] border border-field px-3 text-[13px] font-semibold tracking-wide text-muted transition-colors hover:border-accent hover:text-ink ${className}`}
    >
      <span aria-hidden>{LANG_SHORT[other]}</span>
    </button>
  );
}

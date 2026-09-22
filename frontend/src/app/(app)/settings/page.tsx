"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense } from "react";

import { AccountSettings } from "@/components/account-settings";
import { Icon } from "@/components/icons";
import { Spinner } from "@/components/ui";
import { LANG_LABEL, LANGS, useLang, useT, type Key } from "@/lib/i18n";
import {
  COLOR_DOT,
  COLOR_NAME,
  HIGHLIGHT_COLORS,
  MAX_COLOR_LABEL,
  colorLabel,
  usePreferences,
  type ColumnWidth,
  type HighlightColor,
  type LineHeight,
  type OpenMode,
} from "@/lib/preferences";
import type { AppTheme, Lang } from "@/lib/types";

// Only day and night here; the sepia page is chosen inside the reader, for that sitting only.
const THEMES: [AppTheme, Key][] = [
  ["light", "settings.themeLight"],
  ["dark", "settings.themeDark"],
];
const LINE_HEIGHTS: [LineHeight, Key][] = [
  [1.5, "settings.lhTight"],
  [1.65, "settings.lhNormal"],
  [1.8, "settings.lhLoose"],
];
const WIDTHS: [ColumnWidth, Key][] = [
  [600, "settings.widthNarrow"],
  [680, "settings.widthMedium"],
  [780, "settings.widthWide"],
];
const MODES: [OpenMode, Key][] = [
  ["clean", "settings.modeClean"],
  ["original", "settings.modeOriginal"],
];

const TABS = [
  ["reading", "settings.tabReading"],
  ["account", "settings.tabAccount"],
] as const;
type Tab = (typeof TABS)[number][0];

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <span className="text-[15px] font-medium">{label}</span>
      <div className="flex flex-wrap items-center gap-1.5" role="radiogroup" aria-label={label}>
        {children}
      </div>
    </div>
  );
}

/**
 * UI-10 / UI-11: reading options and the account, on two tabs (FR-ACC-01..05).
 *
 * Nothing here is a draft any more: every choice is applied as it is picked and <PreferencesSync/>
 * carries it to the account, so there is no save button and no "did that stick?" moment.
 */
function Settings() {
  const prefs = usePreferences();
  const t = useT();
  const lang = useLang();
  const router = useRouter();
  const params = useSearchParams();
  const tab: Tab = params.get("tab") === "account" ? "account" : "reading";

  const setLabel = (color: HighlightColor, value: string) =>
    prefs.set({ colorLabels: { ...prefs.colorLabels, [color]: value.slice(0, MAX_COLOR_LABEL) } });

  const option = <T extends string | number>(value: T, current: T, label: string, pick: (v: T) => void) => (
    <button key={String(value)} type="button" role="radio" aria-checked={value === current} className="chip" onClick={() => pick(value)}>
      {label}
    </button>
  );

  return (
    <div className="mx-auto flex max-w-[1080px] flex-col gap-7">
      <h1 className="font-serif text-4xl font-medium sm:text-5xl">{t("settings.title")}</h1>

      <div className="flex gap-1" role="tablist" aria-label={t("settings.title")}>
        {TABS.map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            onClick={() => router.replace(id === "account" ? "/settings?tab=account" : "/settings", { scroll: false })}
            className={`flex h-10 items-center rounded-full px-4 text-[15px] transition-colors ${
              tab === id ? "bg-ink font-semibold text-bg" : "text-ink hover:bg-soft"
            }`}
          >
            {t(label)}
          </button>
        ))}
      </div>

      {tab === "account" ? (
        <AccountSettings />
      ) : (
        <section className="grid gap-6 lg:grid-cols-2">
          <div className="card flex flex-col gap-[22px] p-6 sm:p-7">
            <h2 className="font-serif text-[26px] font-medium">{t("settings.readerDefaults")}</h2>

            {/* FR-ACC-04: the interface language, next to the other things kept with the account. */}
            <Row label={t("settings.language")}>
              {LANGS.map((l) => option(l, lang, LANG_LABEL[l], (language: Lang) => prefs.set({ language })))}
            </Row>
            <span className="-mt-3 text-[13px] leading-normal text-muted">{t("settings.languageHint")}</span>

            <div className="flex items-center justify-between">
              <span className="text-[15px] font-medium">{t("settings.fontSize")}</span>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  aria-label={t("settings.smaller")}
                  className="icon-btn border border-field font-serif text-[15px]"
                  disabled={prefs.fontSize <= 14}
                  onClick={() => prefs.set({ fontSize: prefs.fontSize - 1 })}
                >
                  A
                </button>
                <span className="w-14 text-center text-[15px]" aria-live="polite">
                  {prefs.fontSize}px
                </span>
                <button
                  type="button"
                  aria-label={t("settings.bigger")}
                  className="icon-btn border border-field font-serif text-[21px]"
                  disabled={prefs.fontSize >= 28}
                  onClick={() => prefs.set({ fontSize: prefs.fontSize + 1 })}
                >
                  A
                </button>
              </div>
            </div>
            <Row label={t("settings.theme")}>
              {THEMES.map(([v, l]) => option(v, prefs.theme, t(l), (theme: AppTheme) => prefs.set({ theme })))}
            </Row>
            <Row label={t("settings.lineHeight")}>
              {LINE_HEIGHTS.map(([v, l]) => option(v, prefs.lineHeight, t(l), (lineHeight) => prefs.set({ lineHeight })))}
            </Row>
            <Row label={t("settings.columnWidth")}>
              {WIDTHS.map(([v, l]) => option(v, prefs.width, t(l), (width) => prefs.set({ width })))}
            </Row>
            <Row label={t("settings.openPdfAs")}>
              {MODES.map(([v, l]) => option(v, prefs.defaultMode, t(l), (defaultMode) => prefs.set({ defaultMode })))}
            </Row>

            {/* Naming the colors is a one-off, so it stays folded away with the colors themselves as the hint. */}
            <details className="group border-t border-line pt-5">
              <summary className="flex h-11 cursor-pointer list-none items-center justify-between gap-3 text-[15px] font-semibold [&::-webkit-details-marker]:hidden">
                <span>{t("settings.colorMeaning")}</span>
                <span className="flex items-center gap-1.5">
                  {HIGHLIGHT_COLORS.map((c) => (
                    <span key={c} className="h-2.5 w-2.5 rounded-full" style={{ background: COLOR_DOT[c] }} />
                  ))}
                  <Icon name="down" size={16} className="text-muted transition-transform group-open:rotate-180" />
                </span>
              </summary>
              <div className="flex flex-col gap-3 pt-3">
                <span className="text-[13px] leading-normal text-muted">{t("settings.colorMeaningHint")}</span>
                <div className="grid gap-2.5 sm:grid-cols-2">
                  {HIGHLIGHT_COLORS.map((c) => (
                    <label
                      key={c}
                      className="flex h-11 items-center gap-2.5 rounded-[10px] border border-field bg-page px-3 focus-within:border-accent"
                    >
                      <span className="h-3.5 w-3.5 shrink-0 rounded-full" style={{ background: COLOR_DOT[c] }} />
                      <span className="sr-only">{t("settings.colorMeaningOf", { color: COLOR_NAME[lang][c] })}</span>
                      <input
                        value={prefs.colorLabels[c]}
                        onChange={(e) => setLabel(c, e.target.value)}
                        maxLength={MAX_COLOR_LABEL}
                        placeholder={colorLabel(prefs.colorLabels, c, lang)}
                        className="min-w-0 flex-1 bg-transparent text-sm text-ink outline-none"
                      />
                    </label>
                  ))}
                </div>
                <button
                  type="button"
                  className="self-start py-2 text-[13px] text-accent hover:underline"
                  onClick={() => prefs.set({ colorLabels: { yellow: "", green: "", blue: "", pink: "", purple: "" } })}
                >
                  {t("settings.restoreDefaults")}
                </button>
              </div>
            </details>
          </div>

          <div
            data-theme={prefs.theme}
            aria-label={t("settings.preview")}
            className="flex flex-col gap-3.5 overflow-hidden rounded-[14px] border border-line bg-bg px-8 py-9 text-body sm:px-10"
          >
            <span className="eyebrow">{t("settings.previewEyebrow", { width: prefs.width })}</span>
            <span className="font-serif text-[34px] font-medium text-ink">{t("settings.previewTitle")}</span>
            <p className="font-serif" style={{ fontSize: prefs.fontSize, lineHeight: prefs.lineHeight, maxWidth: prefs.width }}>
              {t("settings.previewBefore")}
              <span className="hl-bg-yellow box-decoration-clone">{t("settings.previewHighlight")}</span>
              {t("settings.previewAfter")}
            </p>
            <div className="mt-auto flex flex-wrap gap-2 pt-2">
              {HIGHLIGHT_COLORS.map((c) => (
                <span key={c} className="inline-flex h-7 items-center gap-1.5 rounded-full bg-soft px-2.5 text-xs font-semibold text-ink">
                  <span className="h-2.5 w-2.5 rounded-full" style={{ background: COLOR_DOT[c] }} />
                  {colorLabel(prefs.colorLabels, c, lang)}
                </span>
              ))}
            </div>
            <span className="flex items-center gap-1.5 text-xs text-muted">
              <Icon name="note" size={14} />
              {t("settings.syncNote")}
            </span>
          </div>
        </section>
      )}
    </div>
  );
}

export default function SettingsPage() {
  return (
    <Suspense fallback={<Spinner />}>
      <Settings />
    </Suspense>
  );
}

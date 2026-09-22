"use client";

import { useEffect, useState } from "react";

import { AccountSettings } from "@/components/account-settings";
import { Icon } from "@/components/icons";
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
import type { Lang, Theme } from "@/lib/types";
import { useUi } from "@/lib/ui-store";

const THEMES: [Theme, Key][] = [
  ["light", "settings.themeLight"],
  ["sepia", "settings.themeSepia"],
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

/** UI-10 / UI-11: reader defaults, highlight color meanings and profile (FR-ACC-01..05). */
export default function SettingsPage() {
  const prefs = usePreferences();
  const showToast = useUi((s) => s.showToast);
  const t = useT();
  const lang = useLang();
  const [draft, setDraft] = useState(() => ({
    theme: prefs.theme,
    fontSize: prefs.fontSize,
    lineHeight: prefs.lineHeight,
    width: prefs.width,
    defaultMode: prefs.defaultMode,
    colorLabels: prefs.colorLabels,
  }));

  // Server preferences may arrive after mount; follow them until the user edits.
  const [touched, setTouched] = useState(false);
  useEffect(() => {
    if (touched) return;
    setDraft({
      theme: prefs.theme,
      fontSize: prefs.fontSize,
      lineHeight: prefs.lineHeight,
      width: prefs.width,
      defaultMode: prefs.defaultMode,
      colorLabels: prefs.colorLabels,
    });
  }, [touched, prefs.theme, prefs.fontSize, prefs.lineHeight, prefs.width, prefs.defaultMode, prefs.colorLabels]);

  const edit = (patch: Partial<typeof draft>) => {
    setTouched(true);
    setDraft((d) => ({ ...d, ...patch }));
  };
  const setLabel = (color: HighlightColor, value: string) =>
    edit({ colorLabels: { ...draft.colorLabels, [color]: value.slice(0, MAX_COLOR_LABEL) } });

  const dirty =
    draft.theme !== prefs.theme ||
    draft.fontSize !== prefs.fontSize ||
    draft.lineHeight !== prefs.lineHeight ||
    draft.width !== prefs.width ||
    draft.defaultMode !== prefs.defaultMode ||
    HIGHLIGHT_COLORS.some((c) => draft.colorLabels[c] !== prefs.colorLabels[c]);

  function save() {
    prefs.set({ ...draft, colorLabels: { ...draft.colorLabels } });
    setTouched(false);
    showToast(t("settings.savedReading"));
  }

  const option = <T extends string | number>(value: T, current: T, label: string, pick: (v: T) => void) => (
    <button key={String(value)} type="button" role="radio" aria-checked={value === current} className="chip" onClick={() => pick(value)}>
      {label}
    </button>
  );

  return (
    <div className="mx-auto flex max-w-[1080px] flex-col gap-7">
      <h1 className="font-serif text-4xl font-medium sm:text-5xl">{t("settings.title")}</h1>

      <section className="grid gap-6 lg:grid-cols-2">
        <div className="card flex flex-col gap-[22px] p-6 sm:p-7">
          <h2 className="font-serif text-[26px] font-medium">{t("settings.readerDefaults")}</h2>

          {/* FR-ACC-04: the interface language, next to the other things kept with the account. */}
          <Row label={t("settings.language")}>
            {LANGS.map((l) =>
              option(l, lang, LANG_LABEL[l], (language: Lang) => prefs.set({ language })),
            )}
          </Row>
          <span className="-mt-3 text-[13px] leading-normal text-muted">{t("settings.languageHint")}</span>

          <div className="flex items-center justify-between">
            <span className="text-[15px] font-medium">{t("settings.fontSize")}</span>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                aria-label={t("settings.smaller")}
                className="icon-btn border border-field font-serif text-[15px]"
                disabled={draft.fontSize <= 14}
                onClick={() => edit({ fontSize: draft.fontSize - 1 })}
              >
                A
              </button>
              <span className="w-14 text-center text-[15px]" aria-live="polite">
                {draft.fontSize}px
              </span>
              <button
                type="button"
                aria-label={t("settings.bigger")}
                className="icon-btn border border-field font-serif text-[21px]"
                disabled={draft.fontSize >= 28}
                onClick={() => edit({ fontSize: draft.fontSize + 1 })}
              >
                A
              </button>
            </div>
          </div>
          <Row label={t("settings.theme")}>
            {THEMES.map(([v, l]) => option(v, draft.theme, t(l), (theme) => edit({ theme })))}
          </Row>
          <Row label={t("settings.lineHeight")}>
            {LINE_HEIGHTS.map(([v, l]) => option(v, draft.lineHeight, t(l), (lineHeight) => edit({ lineHeight })))}
          </Row>
          <Row label={t("settings.columnWidth")}>
            {WIDTHS.map(([v, l]) => option(v, draft.width, t(l), (width) => edit({ width })))}
          </Row>
          <Row label={t("settings.openPdfAs")}>
            {MODES.map(([v, l]) => option(v, draft.defaultMode, t(l), (defaultMode) => edit({ defaultMode })))}
          </Row>

          <div className="flex flex-col gap-3 border-t border-line pt-5">
            <div className="flex items-center justify-between">
              <h3 className="text-[15px] font-semibold">{t("settings.colorMeaning")}</h3>
              <button
                type="button"
                className="py-2 text-[13px] text-accent hover:underline"
                onClick={() => edit({ colorLabels: { yellow: "", green: "", blue: "", pink: "", purple: "" } })}
              >
                {t("settings.restoreDefaults")}
              </button>
            </div>
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
                    value={draft.colorLabels[c]}
                    onChange={(e) => setLabel(c, e.target.value)}
                    maxLength={MAX_COLOR_LABEL}
                    placeholder={colorLabel(draft.colorLabels, c, lang)}
                    className="min-w-0 flex-1 bg-transparent text-sm text-ink outline-none"
                  />
                </label>
              ))}
            </div>
          </div>

          <button type="button" className="btn-primary h-[46px] self-start px-[22px]" onClick={save} disabled={!dirty}>
            {t("settings.saveReading")}
          </button>
        </div>

        <div
          data-theme={draft.theme}
          aria-label={t("settings.preview")}
          className="flex flex-col gap-3.5 overflow-hidden rounded-[14px] border border-line bg-bg px-8 py-9 text-body sm:px-10"
        >
          <span className="eyebrow">{t("settings.previewEyebrow", { width: draft.width })}</span>
          <span className="font-serif text-[34px] font-medium text-ink">{t("settings.previewTitle")}</span>
          <p className="font-serif" style={{ fontSize: draft.fontSize, lineHeight: draft.lineHeight, maxWidth: draft.width }}>
            {t("settings.previewBefore")}
            <span className="hl-bg-yellow box-decoration-clone">{t("settings.previewHighlight")}</span>
            {t("settings.previewAfter")}
          </p>
          <div className="mt-auto flex flex-wrap gap-2 pt-2">
            {HIGHLIGHT_COLORS.map((c) => (
              <span key={c} className="inline-flex h-7 items-center gap-1.5 rounded-full bg-soft px-2.5 text-xs font-semibold text-ink">
                <span className="h-2.5 w-2.5 rounded-full" style={{ background: COLOR_DOT[c] }} />
                {colorLabel(draft.colorLabels, c, lang)}
              </span>
            ))}
          </div>
          <span className="flex items-center gap-1.5 text-xs text-muted">
            <Icon name="note" size={14} />
            {t("settings.syncNote")}
          </span>
        </div>
      </section>

      <AccountSettings />
    </div>
  );
}

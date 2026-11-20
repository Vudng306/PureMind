"use client";

import Link from "next/link";

import { useLang, useT, type Key } from "@/lib/i18n";
import type { Block, Inline } from "@/lib/markdown";
import { usePreferences, type ColumnWidth, type FontFamily, type LineHeight } from "@/lib/preferences";
import type { Theme } from "@/lib/types";

import { Icon } from "./icons";

const THEMES: { value: Theme; label: Key; swatch: string }[] = [
  { value: "light", label: "reader.themeLightLabel", swatch: "#F4EFE4" },
  { value: "sepia", label: "reader.themeSepiaLabel", swatch: "#EBDDC3" },
  { value: "dark", label: "reader.themeDarkLabel", swatch: "#1B1A17" },
];
const LINE_HEIGHTS: [LineHeight, Key][] = [
  [1.5, "settings.lhTight"],
  [1.65, "settings.lhNormal"],
  [1.8, "settings.lhLoose"],
];
const FONTS: [FontFamily, Key][] = [
  ["serif", "reader.fontSerif"],
  ["sans", "reader.fontSans"],
];
const WIDTHS: [ColumnWidth, Key][] = [
  [600, "settings.widthNarrow"],
  [680, "settings.widthMedium"],
  [780, "settings.widthWide"],
];

const inlineText = (nodes: Inline[]): string => nodes.map((n) => ("v" in n ? n.v : "c" in n ? inlineText(n.c) : " ")).join("");

/** How much of the text the phone's bars cover (px), kept clear at its two ends. */
export const TOP_BAR = 52;
export const BOTTOM_BAR = 56;

/** FR-RDR-03: the page and type of the reader. The original PDF only has a page to choose. */
export function ReadingOptions({
  clean,
  showTimeLeft,
  readingTheme,
}: {
  clean: boolean;
  /** RD-112: the estimate is a guide, and it can be turned off. */
  showTimeLeft: boolean;
  readingTheme: Theme;
}) {
  const t = useT();
  const { theme, fontSize, lineHeight, width, fontFamily, timeLeft, set: setPrefs } = usePreferences();
  const chip = "chip flex-1 max-md:h-11";
  const label = "text-[13px] font-semibold text-muted";

  return (
    <div className="flex flex-col gap-4">
      {clean && (
        <div className="flex items-center justify-between gap-2">
          <span className={label}>{t("reader.textSize")}</span>
          <div className="flex items-center">
            <button
              type="button"
              aria-label={t("reader.textSmaller")}
              className="icon-btn h-10 w-10 font-serif text-[15px] max-md:h-11 max-md:w-11"
              disabled={fontSize <= 14}
              onClick={() => setPrefs({ fontSize: fontSize - 1 })}
            >
              A
            </button>
            <span className="w-[34px] text-center text-[13px] tabular-nums text-muted" aria-live="polite">
              {fontSize}
            </span>
            <button
              type="button"
              aria-label={t("reader.textBigger")}
              className="icon-btn h-10 w-10 font-serif text-[21px] max-md:h-11 max-md:w-11"
              disabled={fontSize >= 28}
              onClick={() => setPrefs({ fontSize: fontSize + 1 })}
            >
              A
            </button>
          </div>
        </div>
      )}
      <div className="flex flex-col gap-2">
        <span className={label}>{t("reader.themeAria")}</span>
        <div className="flex items-center gap-1" role="radiogroup" aria-label={t("reader.themeAria")}>
          {THEMES.map((th) => (
            <button
              key={th.value}
              type="button"
              role="radio"
              aria-checked={readingTheme === th.value}
              title={t(th.label)}
              // The app's own theme is "no page of the reader's own", so the reader goes on following it.
              onClick={() => setPrefs({ readingTheme: th.value === theme ? null : th.value })}
              className="flex h-11 min-w-0 flex-1 items-center justify-center gap-2 rounded-[10px] border border-line text-[13px] text-ink hover:bg-soft max-md:h-14 max-md:flex-col max-md:gap-1 max-md:text-[12px]"
              style={{ borderColor: readingTheme === th.value ? "rgb(var(--accent))" : undefined }}
            >
              <span className="h-[18px] w-[18px] shrink-0 rounded-full border border-line" style={{ background: th.swatch }} />
              <span className="truncate">{t(th.label)}</span>
            </button>
          ))}
        </div>
      </div>
      {clean && (
        <>
          <div className="flex flex-col gap-2">
            <span className={label}>{t("reader.fontFamily")}</span>
            <div className="flex gap-1.5" role="radiogroup" aria-label={t("reader.fontFamily")}>
              {FONTS.map(([v, l]) => (
                <button
                  key={v}
                  type="button"
                  role="radio"
                  aria-checked={fontFamily === v}
                  className={`${chip} ${v === "sans" ? "font-sans" : "font-serif"}`}
                  onClick={() => setPrefs({ fontFamily: v })}
                >
                  {t(l)}
                </button>
              ))}
            </div>
          </div>
          <div className="flex flex-col gap-2">
            <span className={label}>{t("settings.lineHeight")}</span>
            <div className="flex gap-1.5" role="radiogroup" aria-label={t("settings.lineHeight")}>
              {LINE_HEIGHTS.map(([v, l]) => (
                <button key={v} type="button" role="radio" aria-checked={lineHeight === v} className={chip} onClick={() => setPrefs({ lineHeight: v })}>
                  {t(l)}
                </button>
              ))}
            </div>
          </div>
          {/* A phone's column is as wide as the phone, whichever is picked here. */}
          <div className="flex flex-col gap-2 max-md:hidden">
            <span className={label}>{t("settings.columnWidth")}</span>
            <div className="flex gap-1.5" role="radiogroup" aria-label={t("settings.columnWidth")}>
              {WIDTHS.map(([v, l]) => (
                <button key={v} type="button" role="radio" aria-checked={width === v} className={chip} onClick={() => setPrefs({ width: v })}>
                  {t(l)}
                </button>
              ))}
            </div>
          </div>
        </>
      )}
      {showTimeLeft && (
        <label className="flex items-start gap-2.5 text-[13px] text-ink max-md:min-h-11">
          <input
            type="checkbox"
            role="switch"
            checked={timeLeft}
            onChange={(e) => setPrefs({ timeLeft: e.target.checked })}
            className="mt-0.5 h-4 w-4 accent-[rgb(var(--accent))]"
          />
          <span className="flex flex-col gap-0.5">
            <span className="font-semibold">{t("reader.timeLeft")}</span>
            <span className="text-muted">{t("reader.timeLeftHint")}</span>
          </span>
        </label>
      )}
      <Link href="/settings" className="flex items-center gap-1.5 text-[13px] text-accent-text hover:underline max-md:h-11">
        <Icon name="gear" size={14} />
        {t("settings.allOptions")}
      </Link>
    </div>
  );
}

/** The headings of the clean text, each going to its place. */
export function ReaderOutline({
  headings,
  pageOf,
  onGo,
}: {
  headings: Block[];
  /** The page a heading is on, for a document that has pages. */
  pageOf?: (blockId: string) => number | undefined;
  onGo: (blockId: string) => void;
}) {
  const t = useT();
  return (
    <nav className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto overscroll-contain px-2 pb-[calc(16px+env(safe-area-inset-bottom))]">
      {headings.length === 0 ? (
        <p className="px-2 py-1 text-[13px] leading-relaxed text-muted">{t("reader.noHeadings")}</p>
      ) : (
        headings.map((hd) => (
          <button
            key={hd.id}
            type="button"
            onClick={() => onGo(hd.id)}
            className="flex min-h-9 shrink-0 items-start justify-between gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] leading-snug text-body hover:bg-soft hover:text-ink max-md:min-h-11 max-md:items-center max-md:text-[15px]"
            style={{ paddingLeft: hd.t === "heading" ? 8 + (hd.level - 1) * 12 : 8 }}
          >
            <span className={`line-clamp-2 ${hd.t === "heading" && hd.level === 1 ? "font-semibold text-ink" : ""}`}>
              {hd.t === "heading" && inlineText(hd.c)}
            </span>
            {pageOf && <span className="shrink-0 text-xs tabular-nums text-muted">{pageOf(hd.id)}</span>}
          </button>
        ))
      )}
    </nav>
  );
}

/** The reader's two bars on a phone: what is being read above, what can be opened beside it under the thumb.
 * They lie over the text and step aside while it is being read on. */
export function PhoneReaderBars({
  topShown,
  bottomShown,
  title,
  progress,
  pagerRef,
  sideIcon = "toc",
  sideLabel,
  notes,
  onSide,
  onNotes,
  onAi,
  onOptions,
  onMore,
}: {
  topShown: boolean;
  bottomShown: boolean;
  title: string;
  progress: string;
  /** Given on the original PDF, where the page field takes the place of the title. */
  pagerRef?: (el: HTMLElement | null) => void;
  sideIcon?: "toc" | "file";
  sideLabel: string;
  notes: number;
  onSide: () => void;
  onNotes: () => void;
  onAi: () => void;
  onOptions: () => void;
  onMore: () => void;
}) {
  const t = useT();
  const lang = useLang();
  const tab = "flex h-14 min-w-0 flex-col items-center justify-center gap-0.5 text-[11px] font-medium text-muted active:bg-soft";
  return (
    <>
      <div
        inert={!topShown}
        className={`absolute inset-x-0 top-0 z-10 flex items-center gap-0.5 border-b border-line bg-bg px-1 transition-transform duration-200 ${
          topShown ? "" : "-translate-y-full"
        }`}
        style={{ height: TOP_BAR }}
      >
        <Link href="/library" className="icon-btn shrink-0" aria-label={t("reader.backToLibrary")}>
          <Icon name="back" size={20} />
        </Link>
        {pagerRef ? (
          <div ref={pagerRef} className="flex min-w-0 flex-1 justify-center" />
        ) : (
          <div className="flex min-w-0 flex-1 flex-col justify-center px-1" lang={lang}>
            <span className="truncate text-[14px] font-semibold leading-tight text-ink">{title}</span>
            <span className="truncate text-[12px] tabular-nums leading-snug text-muted">{progress}</span>
          </div>
        )}
        <button type="button" className="icon-btn shrink-0 font-serif text-[17px] font-semibold" aria-label={t("settings.readingOptions")} onClick={onOptions}>
          Aa
        </button>
        <button type="button" className="icon-btn shrink-0" aria-label={t("reader.more")} onClick={onMore}>
          <Icon name="more" />
        </button>
      </div>

      <div
        inert={!bottomShown}
        className={`absolute inset-x-0 bottom-0 z-10 grid grid-cols-3 border-t border-line bg-bg pb-[env(safe-area-inset-bottom)] transition-transform duration-200 ${
          bottomShown ? "" : "translate-y-full"
        }`}
      >
        <button type="button" className={tab} onClick={onSide}>
          <Icon name={sideIcon} size={20} />
          <span className="max-w-full truncate">{sideLabel}</span>
        </button>
        <button type="button" className={tab} aria-label={t("reader.notesButton", { n: notes })} onClick={onNotes}>
          <Icon name="highlighter" size={20} />
          <span className="max-w-full truncate">
            {t("reader.tabNotes")}
            {notes > 0 && <span className="tabular-nums"> · {notes}</span>}
          </span>
        </button>
        <button type="button" className={tab} aria-label={t("reader.aiButton")} onClick={onAi}>
          <Icon name="spark" size={20} />
          <span className="max-w-full truncate">{t("reader.tabAi")}</span>
        </button>
      </div>
    </>
  );
}

"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";

import type { Lang, ReadingPreferences, Theme } from "./types";

export type HighlightColor = "yellow" | "green" | "blue" | "pink" | "purple";
export type LineHeight = 1.5 | 1.65 | 1.8;
export type ColumnWidth = 600 | 680 | 780;
export type OpenMode = "clean" | "original";

export const HIGHLIGHT_COLORS: HighlightColor[] = ["yellow", "green", "blue", "pink", "purple"];

const EMPTY_LABELS: Record<HighlightColor, string> = {
  yellow: "",
  green: "",
  blue: "",
  pink: "",
  purple: "",
};

/**
 * What a color is called when the user has not named it themselves. Kept here rather than in the
 * i18n dictionary because `preferences` is what i18n reads the language from, and the other way
 * round would be a cycle.
 */
export const DEFAULT_COLOR_LABELS: Record<Lang, Record<HighlightColor, string>> = {
  vi: { yellow: "Ý chính", green: "Ví dụ", blue: "Định nghĩa", pink: "Chưa hiểu", purple: "Cần nhớ" },
  en: { yellow: "Key point", green: "Example", blue: "Definition", pink: "Unclear", purple: "Remember" },
};

export const COLOR_NAME: Record<Lang, Record<HighlightColor, string>> = {
  vi: { yellow: "vàng", green: "xanh lá", blue: "xanh dương", pink: "hồng", purple: "tím" },
  en: { yellow: "yellow", green: "green", blue: "blue", pink: "pink", purple: "purple" },
};

export const COLOR_DOT: Record<HighlightColor, string> = {
  yellow: "#E3B94A",
  green: "#6FB05C",
  blue: "#5F95D6",
  pink: "#D8739A",
  purple: "#9A7BD0",
};

export const MAX_COLOR_LABEL = 24;

interface Prefs {
  theme: Theme;
  fontSize: number;
  lineHeight: LineHeight;
  width: ColumnWidth;
  defaultMode: OpenMode;
  language: Lang;
  /** Empty means "use the name for this color in the current language". */
  colorLabels: Record<HighlightColor, string>;
}

interface PreferencesState extends Prefs {
  set: (p: Partial<Prefs>) => void;
  applyServer: (p: ReadingPreferences) => void;
}

/**
 * Labels the app itself wrote before it spoke English: they were stored as if the user had typed
 * them, so they are cleared back to "not named" and follow the language from now on.
 */
function unnamed(labels: Partial<Record<HighlightColor, string>> | undefined) {
  const out = { ...EMPTY_LABELS, ...labels };
  for (const color of HIGHLIGHT_COLORS) {
    if (out[color] === DEFAULT_COLOR_LABELS.vi[color]) out[color] = "";
  }
  return out;
}

/**
 * FR-ACC-04: applied locally at once and synced to the account by <PreferencesSync/>.
 */
export const usePreferences = create<PreferencesState>()(
  persist(
    (set) => ({
      theme: "light",
      fontSize: 19,
      lineHeight: 1.65,
      width: 680,
      defaultMode: "clean",
      language: "vi",
      colorLabels: EMPTY_LABELS,
      set: (p) => set(p),
      applyServer: (p) =>
        set((s) => ({
          theme: p.theme ?? s.theme,
          fontSize: p.font_size ?? s.fontSize,
          lineHeight: p.line_height ?? s.lineHeight,
          width: p.column_width ?? s.width,
          defaultMode: p.default_mode ?? s.defaultMode,
          language: p.language ?? s.language,
          colorLabels: p.color_labels ? unnamed(p.color_labels) : s.colorLabels,
        })),
    }),
    {
      name: "puremind-preferences",
      partialize: ({ theme, fontSize, lineHeight, width, defaultMode, language, colorLabels }) => ({
        theme,
        fontSize,
        lineHeight,
        width,
        defaultMode,
        language,
        colorLabels,
      }),
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<Prefs>;
        return { ...current, ...p, colorLabels: unnamed(p.colorLabels) };
      },
    },
  ),
);

/** The language chosen right now, for code that runs outside React. */
export function currentLang(): Lang {
  return usePreferences.getState().language;
}

/** Label shown for a color; an unnamed color falls back to the color's name. */
export function colorLabel(
  labels: Record<HighlightColor, string>,
  color: HighlightColor,
  lang: Lang = currentLang(),
): string {
  if (labels[color]?.trim()) return labels[color].trim();
  return lang === "en" ? `${COLOR_NAME.en[color]} highlight` : `Màu ${COLOR_NAME.vi[color]}`;
}

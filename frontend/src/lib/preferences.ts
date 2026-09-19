"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";

import type { ReadingPreferences, Theme } from "./types";

export type HighlightColor = "yellow" | "green" | "blue" | "pink" | "purple";
export type LineHeight = 1.5 | 1.65 | 1.8;
export type ColumnWidth = 600 | 680 | 780;
export type OpenMode = "clean" | "original";

export const HIGHLIGHT_COLORS: HighlightColor[] = ["yellow", "green", "blue", "pink", "purple"];

export const DEFAULT_COLOR_LABELS: Record<HighlightColor, string> = {
  yellow: "Ý chính",
  green: "Ví dụ",
  blue: "Định nghĩa",
  pink: "Chưa hiểu",
  purple: "Cần nhớ",
};

export const COLOR_NAME: Record<HighlightColor, string> = {
  yellow: "vàng",
  green: "xanh lá",
  blue: "xanh dương",
  pink: "hồng",
  purple: "tím",
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
  colorLabels: Record<HighlightColor, string>;
}

interface PreferencesState extends Prefs {
  set: (p: Partial<Prefs>) => void;
  applyServer: (p: ReadingPreferences) => void;
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
      colorLabels: DEFAULT_COLOR_LABELS,
      set: (p) => set(p),
      applyServer: (p) =>
        set((s) => ({
          theme: p.theme ?? s.theme,
          fontSize: p.font_size ?? s.fontSize,
          lineHeight: p.line_height ?? s.lineHeight,
          width: p.column_width ?? s.width,
          defaultMode: p.default_mode ?? s.defaultMode,
          colorLabels: p.color_labels ? { ...DEFAULT_COLOR_LABELS, ...p.color_labels } : s.colorLabels,
        })),
    }),
    {
      name: "puremind-preferences",
      partialize: ({ theme, fontSize, lineHeight, width, defaultMode, colorLabels }) => ({
        theme,
        fontSize,
        lineHeight,
        width,
        defaultMode,
        colorLabels,
      }),
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<Prefs>;
        return { ...current, ...p, colorLabels: { ...DEFAULT_COLOR_LABELS, ...p.colorLabels } };
      },
    },
  ),
);

/** Label shown for a color; an emptied label falls back to the color's name. */
export function colorLabel(labels: Record<HighlightColor, string>, color: HighlightColor): string {
  return labels[color]?.trim() || `Màu ${COLOR_NAME[color]}`;
}

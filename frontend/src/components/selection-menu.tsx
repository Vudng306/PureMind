"use client";

import { useEffect, useRef } from "react";

import { useLang, useT } from "@/lib/i18n";
import { COLOR_DOT, HIGHLIGHT_COLORS, colorLabel, usePreferences, type HighlightColor } from "@/lib/preferences";

import { Icon } from "./icons";

/** A clean-text or PDF selection: the menu only needs its position on screen. */
type Selected = { rect: DOMRect };

const MENU_W = 530;
const MENU_H = 104;

/** Where the menu sits for a selection at `rect`: above it when there is room, otherwise below. */
export function selectionMenuBounds(rect: DOMRect): { top: number; bottom: number } {
  const above = rect.top - MENU_H - 10;
  const top = above > 12 ? above : Math.min(rect.bottom + 10, window.innerHeight - MENU_H - 12);
  return { top, bottom: top + MENU_H };
}

/** Dark floating menu over a selected passage: color by meaning, note, copy, explain, translate. */
export function SelectionMenu({
  selection,
  onColor,
  onNote,
  onCopy,
  onExplain,
  onTranslate,
  onSource,
  onDismiss,
}: {
  selection: Selected;
  onColor: (color: HighlightColor) => void;
  onNote: () => void;
  onCopy: () => void;
  /** Left out when the feature is switched off (lib/features). */
  onExplain?: () => void;
  onTranslate?: () => void;
  /** Show the passage on the original PDF; left out where it cannot be placed. */
  onSource?: () => void;
  onDismiss: () => void;
}) {
  const t = useT();
  const lang = useLang();
  const labels = usePreferences((s) => s.colorLabels);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onDown(e: MouseEvent | TouchEvent) {
      const target = e.target as Element | null;
      // A control that changes the layout around the text (Focus) leaves the selection and its menu be.
      if (target?.closest?.("[data-keep-selection]")) return;
      if (!ref.current?.contains(target)) onDismiss();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onDismiss();
    }
    document.addEventListener("mousedown", onDown);
    // selectionchange handles touch selection, including native handles.
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);

      document.removeEventListener("keydown", onKey);
    };
  }, [onDismiss]);

  const { rect } = selection;
  const vw = window.innerWidth;
  const width = Math.min(MENU_W, vw - 24);
  const left = Math.min(Math.max(12, rect.left + rect.width / 2 - width / 2), vw - width - 12);
  const { top } = selectionMenuBounds(rect);

  const item = "flex shrink-0 whitespace-nowrap h-11 items-center gap-1.5 rounded-lg px-2 text-sm hover:bg-menu-fg/10";

  return (
    <div
      ref={ref}
      role="toolbar"
      data-selection-menu
      aria-label={t("selection.aria")}
      // Keep the text selection alive while clicking buttons.
      onMouseDown={(e) => e.preventDefault()}
      className="mobile-selection fixed z-30 flex flex-col gap-0.5 rounded-[14px] bg-menu p-1.5 font-sans text-menu-fg shadow-[0_12px_30px_rgba(0,0,0,0.28)]"
      style={{ left, top, width }}
    >
      <div className="flex items-center gap-0.5 overflow-x-auto [scrollbar-width:none]">
        {HIGHLIGHT_COLORS.map((c) => (
          <button
            key={c}
            type="button"
            aria-label={t("selection.highlightAs", { name: colorLabel(labels, c, lang) })}
            onClick={() => onColor(c)}
            className="flex h-10 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-2 text-[13px] font-semibold hover:bg-menu-fg/10"
          >
            <span className="h-3.5 w-3.5 shrink-0 rounded-full" style={{ background: COLOR_DOT[c] }} />
            {colorLabel(labels, c, lang)}
          </button>
        ))}
      </div>
      <span className="mx-2 my-0.5 h-px bg-menu-fg/20" />
      <div className="flex items-center gap-0.5 overflow-x-auto">
        <button type="button" onClick={onNote} className={item}>
          <Icon name="note" size={16} />
          {t("selection.note")}
        </button>
        <button type="button" onClick={onCopy} className={item}>
          <Icon name="copy" size={16} />
          {t("selection.copyShort")}
        </button>
        {onExplain && (
          <button type="button" onClick={onExplain} className={item}>
            <Icon name="spark" size={16} />
            {t("selection.explain")}
          </button>
        )}
        {onTranslate && (
          <button type="button" onClick={onTranslate} className={item}>
            <Icon name="translate" size={16} />
            {t("selection.translate")}
          </button>
        )}
        {onSource && (
          <button type="button" onClick={onSource} className={item}>
            <Icon name="file" size={16} />
            {t("selection.source")}
          </button>
        )}
      </div>
    </div>
  );
}

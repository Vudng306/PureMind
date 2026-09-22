"use client";

import { useEffect, useRef } from "react";

import { useLang, useT } from "@/lib/i18n";
import { COLOR_DOT, HIGHLIGHT_COLORS, colorLabel, usePreferences, type HighlightColor } from "@/lib/preferences";

import { Icon } from "./icons";

/** A clean-text or PDF selection: the menu only needs its position on screen. */
type Selected = { rect: DOMRect };

const MENU_W = 470;
const MENU_H = 104;

/** Dark floating menu over a selected passage: color by meaning, note, copy, explain. */
export function SelectionMenu({
  selection,
  onColor,
  onNote,
  onCopy,
  onExplain,
  onDismiss,
}: {
  selection: Selected;
  onColor: (color: HighlightColor) => void;
  onNote: () => void;
  onCopy: () => void;
  onExplain: () => void;
  onDismiss: () => void;
}) {
  const t = useT();
  const lang = useLang();
  const labels = usePreferences((s) => s.colorLabels);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onDown(e: MouseEvent | TouchEvent) {
      if (!ref.current?.contains(e.target as Node)) onDismiss();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onDismiss();
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("touchstart", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("touchstart", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [onDismiss]);

  const { rect } = selection;
  const vw = window.innerWidth;
  const width = Math.min(MENU_W, vw - 24);
  const left = Math.min(Math.max(12, rect.left + rect.width / 2 - width / 2), vw - width - 12);
  const above = rect.top - MENU_H - 10;
  const top = above > 12 ? above : Math.min(rect.bottom + 10, window.innerHeight - MENU_H - 12);

  const item = "flex h-11 items-center gap-1.5 rounded-lg px-2 text-sm hover:bg-menu-fg/10";

  return (
    <div
      ref={ref}
      role="toolbar"
      aria-label={t("selection.aria")}
      // Keep the text selection alive while clicking buttons.
      onMouseDown={(e) => e.preventDefault()}
      className="fixed z-30 flex flex-col gap-0.5 rounded-[14px] bg-menu p-1.5 font-sans text-menu-fg shadow-[0_12px_30px_rgba(0,0,0,0.28)]"
      style={{ left, top, width }}
    >
      <div className="flex items-center gap-0.5 overflow-x-auto">
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
      <div className="flex items-center gap-0.5">
        <button type="button" onClick={onNote} className={item}>
          <Icon name="note" size={16} />
          {t("selection.note")}
        </button>
        <button type="button" onClick={onCopy} className={item}>
          <Icon name="copy" size={16} />
          {t("selection.copyShort")}
        </button>
        <button type="button" onClick={onExplain} className={item}>
          <Icon name="spark" size={16} />
          {t("selection.explain")}
        </button>
      </div>
    </div>
  );
}

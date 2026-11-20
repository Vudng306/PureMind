"use client";

import { useEffect, useRef } from "react";

import { useLang, useT } from "@/lib/i18n";
import { COLOR_DOT, HIGHLIGHT_COLORS, colorLabel, usePreferences, type HighlightColor } from "@/lib/preferences";

import { Icon, type IconName } from "./icons";

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

/** What to do with a selection: color by meaning, note, copy, explain, translate. A dark card over the passage,
 * or, `docked` on a phone, a bar along the bottom, clear of the system's own selection handles and menu. */
export function SelectionMenu({
  selection,
  docked = false,
  onColor,
  onNote,
  onCopy,
  onExplain,
  onTranslate,
  onSource,
  onPress,
  onDismiss,
}: {
  selection: Selected;
  docked?: boolean;
  onColor: (color: HighlightColor) => void;
  onNote: () => void;
  onCopy: () => void;
  /** Left out when the feature is switched off (lib/features). */
  onExplain?: () => void;
  onTranslate?: () => void;
  /** Show the passage on the original PDF; left out where it cannot be placed. */
  onSource?: () => void;
  /** A finger came down on the menu: a touch browser may drop the selection before the button gets its click. */
  onPress?: () => void;
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
    // Docked, the menu goes when the selection does: a touch elsewhere may only be moving the text.
    if (!docked) {
      document.addEventListener("mousedown", onDown);
      document.addEventListener("touchstart", onDown);
    }
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("touchstart", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [onDismiss, docked]);

  const actions: { key: string; label: string; icon: IconName; run: () => void }[] = [
    { key: "note", label: t("selection.note"), icon: "note", run: onNote },
    { key: "copy", label: t("selection.copyShort"), icon: "copy", run: onCopy },
    ...(onExplain ? [{ key: "explain", label: t("selection.explain"), icon: "spark" as const, run: onExplain }] : []),
    ...(onTranslate ? [{ key: "translate", label: t("selection.translate"), icon: "translate" as const, run: onTranslate }] : []),
    ...(onSource ? [{ key: "source", label: t("selection.source"), icon: "file" as const, run: onSource }] : []),
  ];

  const cell =
    "flex h-12 min-w-0 flex-1 basis-0 flex-col items-center justify-center gap-1 rounded-lg text-[11px] tracking-tight active:bg-menu-fg/10";
  const item = "flex h-11 items-center gap-1.5 rounded-lg px-2 text-sm hover:bg-menu-fg/10";

  const colors = HIGHLIGHT_COLORS.map((c) => (
    <button
      key={c}
      type="button"
      aria-label={t("selection.highlightAs", { name: colorLabel(labels, c, lang) })}
      onClick={() => onColor(c)}
      className={
        docked
          ? `${cell} font-semibold`
          : "flex h-10 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-2 text-[13px] font-semibold hover:bg-menu-fg/10"
      }
    >
      <span className={`shrink-0 rounded-full ${docked ? "h-4 w-4" : "h-3.5 w-3.5"}`} style={{ background: COLOR_DOT[c] }} />
      <span className="max-w-full truncate">{colorLabel(labels, c, lang)}</span>
    </button>
  ));

  const buttons = actions.map((a) => (
    <button key={a.key} type="button" onClick={a.run} className={docked ? cell : item}>
      <Icon name={a.icon} size={docked ? 18 : 16} />
      <span className="max-w-full truncate">{a.label}</span>
    </button>
  ));

  const shared = {
    ref,
    role: "toolbar",
    "data-selection-menu": true,
    "aria-label": t("selection.aria"),
    // Keep the text selection alive while clicking buttons.
    onMouseDown: (e: React.MouseEvent) => e.preventDefault(),
    onPointerDown: onPress,
  };

  if (docked) {
    return (
      <div
        {...shared}
        className="fixed inset-x-0 z-30 flex flex-col gap-0.5 rounded-t-[18px] bg-menu px-1.5 pb-[calc(6px+env(safe-area-inset-bottom))] pt-1.5 font-sans text-menu-fg shadow-[0_-8px_24px_rgba(0,0,0,0.24)]"
        style={{ bottom: "var(--keyboard-inset, 0px)" }}
      >
        <div className="flex items-stretch gap-0.5">{colors}</div>
        <span className="mx-2 h-px bg-menu-fg/20" />
        <div className="flex items-stretch gap-0.5">{buttons}</div>
      </div>
    );
  }

  const { rect } = selection;
  const vw = window.innerWidth;
  const width = Math.min(MENU_W, vw - 24);
  const left = Math.min(Math.max(12, rect.left + rect.width / 2 - width / 2), vw - width - 12);
  const { top } = selectionMenuBounds(rect);

  return (
    <div
      {...shared}
      className="fixed z-30 flex flex-col gap-0.5 rounded-[14px] bg-menu p-1.5 font-sans text-menu-fg shadow-[0_12px_30px_rgba(0,0,0,0.28)]"
      style={{ left, top, width }}
    >
      <div className="flex items-center gap-0.5 overflow-x-auto [scrollbar-width:none]">{colors}</div>
      <span className="mx-2 my-0.5 h-px bg-menu-fg/20" />
      <div className="flex items-center gap-0.5">{buttons}</div>
    </div>
  );
}

"use client";

import { useEffect, useRef, useState } from "react";

import { MAX_HIGHLIGHT_NOTE } from "@/lib/annotations";
import { useLang, useT } from "@/lib/i18n";
import { MSG } from "@/lib/messages";

import { Icon } from "./icons";
import { selectionMenuBounds } from "./selection-menu";

const CARD_W = 440;
const CARD_MAX_H = 300;

/** A small card under a selected passage to write its note, placed like the translation card. The passage is
 * highlighted only when the note is saved, so closing it leaves the document as it was. */
export function NotePopover({
  text,
  rect,
  initial = "",
  onSave,
  onClose,
}: {
  text: string;
  /** Where the passage was on screen when it was selected. */
  rect: DOMRect;
  /** The note already on this passage's highlight, if it has one. */
  initial?: string;
  onSave: (note: string) => void;
  onClose: () => void;
}) {
  const t = useT();
  const lang = useLang();
  const ref = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState(initial);

  useEffect(() => {
    function onDown(e: MouseEvent | TouchEvent) {
      if (ref.current?.contains(e.target as Element)) return;
      onClose();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("touchstart", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("touchstart", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  function save() {
    if (!draft.trim()) return;
    onSave(draft);
  }

  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const width = Math.min(CARD_W, vw - 24);
  const left = Math.min(Math.max(12, rect.left + rect.width / 2 - width / 2), vw - width - 12);
  // Same place the translation card takes: below the passage and its menu when there is room, else above.
  const menu = selectionMenuBounds(rect);
  const upper = Math.min(rect.top, menu.top);
  const lower = Math.max(rect.bottom, menu.bottom);
  const place =
    lower + 10 + CARD_MAX_H < vh
      ? { top: lower + 10 }
      : upper - 10 - CARD_MAX_H > 12
        ? { bottom: vh - upper + 10 }
        : { top: Math.max(12, vh - CARD_MAX_H - 12) };

  const full = draft.length >= MAX_HIGHLIGHT_NOTE;

  return (
    <div
      ref={ref}
      role="dialog"
      aria-label={t("panel.noteAria")}
      className="fixed z-30 flex flex-col gap-2.5 rounded-[14px] border border-line bg-surface p-3.5 font-sans shadow-[0_12px_30px_rgba(0,0,0,0.22)]"
      style={{ left, width, maxHeight: CARD_MAX_H, ...place }}
    >
      <div className="flex items-center gap-2">
        <Icon name="note" size={16} className="text-accent-text" />
        <span className="flex-1 text-[13px] font-semibold text-ink">{t("selection.note")}</span>
        <button type="button" aria-label={t("common.close")} onClick={onClose} className="icon-btn h-8 w-8 text-muted">
          <Icon name="x" size={15} />
        </button>
      </div>
      <p className="line-clamp-2 border-l-[3px] border-line pl-2.5 text-[13px] italic text-muted">{text}</p>
      <textarea
        aria-label={t("panel.noteAria")}
        autoFocus
        rows={3}
        value={draft}
        maxLength={MAX_HIGHLIGHT_NOTE}
        placeholder={t("panel.notePlaceholder")}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) save();
        }}
        className="min-h-[72px] resize-none rounded-lg border border-accent bg-bg px-3 py-2.5 text-sm leading-normal text-ink outline-none"
      />
      <div className="flex items-center gap-2">
        <span className={`text-xs ${full ? "text-danger" : "text-muted"}`} aria-live="polite">
          {full
            ? MSG["MSG-24"]
            : draft.length > MAX_HIGHLIGHT_NOTE - 1000
              ? `${draft.length.toLocaleString(lang)}/${MAX_HIGHLIGHT_NOTE.toLocaleString(lang)}`
              : t("panel.ctrlEnter")}
        </span>
        <span className="flex-1" />
        <button type="button" onClick={onClose} className="btn-ghost h-8 px-3 text-[13px]">
          {t("common.cancel")}
        </button>
        <button type="button" onClick={save} disabled={!draft.trim()} className="btn-primary h-8 rounded-lg px-3 text-[13px]">
          {t("common.save")}
        </button>
      </div>
    </div>
  );
}

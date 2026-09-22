"use client";

import { useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import {
  CATEGORY_FOR_COLOR,
  MAX_HIGHLIGHT_NOTE,
  saveDocumentNote,
  useHighlightActions,
  type Highlight,
} from "@/lib/annotations";
import { useDocument } from "@/lib/documents";
import { useLang, useT } from "@/lib/i18n";
import { MSG } from "@/lib/messages";
import { notebooksUsing } from "@/lib/notebooks";
import { COLOR_DOT, HIGHLIGHT_COLORS, colorLabel, usePreferences, type HighlightColor } from "@/lib/preferences";
import { useUi } from "@/lib/ui-store";

import { Icon } from "./icons";
import { ChatPanel } from "./chat-panel";
import { SummaryPanel } from "./summary-panel";
import { ConfirmDialog } from "./ui";

export type PanelTab = "highlights" | "notes" | "ai" | "chat";

function HighlightCard({
  h,
  active,
  editing,
  lost,
  onJump,
  onEdit,
  onDone,
}: {
  h: Highlight;
  active: boolean;
  editing: boolean;
  lost: boolean;
  onJump: () => void;
  onEdit: () => void;
  onDone: () => void;
}) {
  const t = useT();
  const lang = useLang();
  const labels = usePreferences((s) => s.colorLabels);
  const showToast = useUi((s) => s.showToast);
  const { updateHighlight, removeHighlight } = useHighlightActions();
  const ref = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState(h.note);
  const opened = useRef(h.note);
  const [confirm, setConfirm] = useState<"note" | "highlight" | null>(null);
  const [usedIn, setUsedIn] = useState(0);

  useEffect(() => {
    if (active) ref.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [active]);

  useEffect(() => {
    if (!editing) return;
    setDraft(h.note);
    opened.current = h.note;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);

  function onDraft(text: string) {
    setDraft(text);
    // An emptied note is only removed after confirmation (FR-NOTE-01).
    if (text.trim()) updateHighlight(h.id, { note: text });
  }

  function finish() {
    if (!draft.trim()) {
      if (h.note.trim()) return setConfirm("note");
      return onDone();
    }
    if (draft !== opened.current) {
      updateHighlight(h.id, { note: draft }, { now: true });
      showToast(t("panel.savedNote"));
    }
    onDone();
  }

  async function remove() {
    // FR-HL-03: confirm when the highlight has a note or is a source of a notebook.
    let used = 0;
    try {
      used = (await notebooksUsing(h.id)).length;
    } catch {
      /* not known (offline or not saved yet): only the note decides */
    }
    setUsedIn(used);
    if (h.note.trim() || used) return setConfirm("highlight");
    removeHighlight(h.id);
    showToast(t("highlights.deleted"));
  }

  return (
    <div
      ref={ref}
      className={`flex flex-col gap-2.5 rounded-xl border p-3.5 transition-colors ${active ? "border-accent" : "border-line"}`}
    >
      <div className="flex items-center gap-2 text-xs text-muted">
        <span className="flex h-6 items-center gap-1.5 rounded-full bg-soft pl-1.5 pr-2 text-xs font-semibold text-ink">
          <span className="h-2.5 w-2.5 rounded-full" style={{ background: COLOR_DOT[h.color] }} />
          {colorLabel(labels, h.color, lang)}
        </span>
        {h.page ? t("panel.pageN", { page: h.page }) : null}
        <span className="flex-1" />
        {HIGHLIGHT_COLORS.map((c) => (
          <button
            key={c}
            type="button"
            aria-label={t("panel.changeTo", { name: colorLabel(labels, c, lang) })}
            title={colorLabel(labels, c, lang)}
            aria-pressed={c === h.color}
            // The color is the category: picking one says what the passage is (FR-HL-04).
            onClick={() => updateHighlight(h.id, { color: c, category: CATEGORY_FOR_COLOR[c] })}
            className="flex h-9 w-[20px] items-center justify-center"
          >
            <span
              className="h-3 w-3 rounded-full"
              style={{
                background: COLOR_DOT[c],
                boxShadow: c === h.color ? "0 0 0 2px rgb(var(--surface)), 0 0 0 3.5px rgb(var(--ink))" : undefined,
              }}
            />
          </button>
        ))}
        <button
          type="button"
          aria-label={t("panel.deleteHighlight")}
          onClick={() => void remove()}
          className="flex h-9 w-9 items-center justify-center rounded-lg text-muted hover:bg-soft hover:text-danger"
        >
          <Icon name="trash" size={16} />
        </button>
      </div>
      <button type="button" onClick={onJump} className="text-left font-serif text-base leading-normal text-ink hover:underline">
        “{h.text}”
      </button>
      {lost &&
        (h.rects ? (
          <p className="rounded-lg bg-soft px-3 py-2 text-xs leading-normal text-muted">
            {t("panel.lostOriginal")}
          </p>
        ) : (
          <p className="rounded-lg bg-danger-soft px-3 py-2 text-xs leading-normal text-danger">
            {t("panel.lostText")}
          </p>
        ))}
      {editing ? (
        <div className="flex flex-col gap-2">
          <textarea
            aria-label={t("panel.noteAria")}
            autoFocus
            rows={3}
            value={draft}
            maxLength={MAX_HIGHLIGHT_NOTE}
            placeholder={t("panel.notePlaceholder")}
            onChange={(e) => onDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) finish();
            }}
            className="resize-y rounded-lg border border-accent bg-bg px-3 py-2.5 text-sm leading-normal text-ink outline-none"
          />
          <div className="flex items-center gap-2">
            <span className={`text-xs ${draft.length >= MAX_HIGHLIGHT_NOTE ? "text-danger" : "text-muted"}`} aria-live="polite">
              {draft.length >= MAX_HIGHLIGHT_NOTE
                ? MSG["MSG-24"]
                : draft.length > MAX_HIGHLIGHT_NOTE - 1000
                  ? `${draft.length.toLocaleString(lang)}/${MAX_HIGHLIGHT_NOTE.toLocaleString(lang)}`
                  : t("panel.ctrlEnter")}
            </span>
            <span className="flex-1" />
            {h.note.trim() && (
              <button type="button" onClick={() => setConfirm("note")} className="h-[38px] px-2 text-sm text-muted hover:text-danger">
                {t("panel.deleteNote")}
              </button>
            )}
            <button type="button" onClick={finish} className="btn-primary h-[38px] rounded-lg px-4 text-sm">
              {t("panel.done")}
            </button>
          </div>
        </div>
      ) : h.note ? (
        <button type="button" onClick={onEdit} className="whitespace-pre-wrap rounded-lg bg-soft px-3 py-2.5 text-left text-sm leading-normal text-body">
          {h.note}
        </button>
      ) : (
        <button type="button" onClick={onEdit} className="h-9 self-start text-sm font-medium text-accent hover:underline">
          {t("panel.addNote")}
        </button>
      )}
      <ConfirmDialog
        open={confirm !== null}
        title={confirm === "note" ? t("panel.deleteNoteQ") : t("panel.deleteHighlightQ")}
        confirmLabel={t("common.delete")}
        onCancel={() => {
          if (confirm === "note") setDraft(h.note);
          setConfirm(null);
        }}
        onConfirm={() => {
          if (confirm === "note") {
            updateHighlight(h.id, { note: "" }, { now: true });
            setDraft("");
            showToast(t("panel.noteDeleted"));
            onDone();
          } else {
            removeHighlight(h.id);
            showToast(t(h.note.trim() ? "panel.bothDeleted" : "highlights.deleted"));
          }
          setConfirm(null);
        }}
      >
        {confirm === "note" ? (
          t("panel.deleteNoteBody")
        ) : (
          <>
            {h.note.trim() && <p>{t("panel.deleteHasNote")}</p>}
            {usedIn > 0 && <p className={h.note.trim() ? "mt-2" : ""}>{t("panel.deleteUsedIn", { n: usedIn })}</p>}
          </>
        )}
      </ConfirmDialog>
    </div>
  );
}

/** Right panel: highlights filtered by meaning, document note, AI summary. */
export function ReaderPanel({
  docId,
  highlights,
  tab,
  onTab,
  onClose,
  activeId,
  editingId,
  onEditing,
  onJump,
  aiQuote,
  onClearQuote,
  onKeyword,
  canHighlight,
  lostIds,
}: {
  docId: string;
  highlights: Highlight[];
  tab: PanelTab;
  onTab: (tab: PanelTab) => void;
  onClose: () => void;
  activeId: string | null;
  editingId: string | null;
  onEditing: (id: string | null) => void;
  onJump: (h: Highlight) => void;
  /** A passage the reader selected to ask AI about (FR-RDR-06), shown in the chat tab. */
  aiQuote: string | null;
  onClearQuote: () => void;
  /** A summary keyword or a cited passage was chosen: find it in the document (FR-RDR-04). */
  onKeyword: (keyword: string) => void;
  canHighlight: boolean;
  /** Highlights that could not be placed in the current text (FR-HL-02). */
  lostIds: string[];
}) {
  const t = useT();
  const lang = useLang();
  const labels = usePreferences((s) => s.colorLabels);
  const qc = useQueryClient();
  const { data: doc } = useDocument(docId);
  const [filter, setFilter] = useState<HighlightColor | "all">("all");
  const [draft, setDraft] = useState(doc?.note ?? "");
  const [status, setStatus] = useState<"saved" | "dirty" | "saving" | "error">("saved");
  const sent = useRef(doc?.note ?? "");

  async function saveNote(text: string) {
    if (text === sent.current) return setStatus("saved");
    setStatus("saving");
    try {
      await saveDocumentNote(qc, docId, text);
      sent.current = text;
      setStatus((s) => (s === "saving" ? "saved" : s));
    } catch {
      setStatus("error");
    }
  }

  // Unsaved text is still sent when the panel closes.
  const latest = useRef(draft);
  latest.current = draft;
  useEffect(
    () => () => {
      if (latest.current !== sent.current) saveDocumentNote(qc, docId, latest.current).catch(() => undefined);
    },
    [qc, docId],
  );

  // Document note autosaves shortly after typing stops.
  useEffect(() => {
    if (status !== "dirty") return;
    const t = setTimeout(() => void saveNote(draft), 800);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, status]);

  const sorted = [...highlights].sort((a, b) => (a.page ?? 0) - (b.page ?? 0) || a.createdAt.localeCompare(b.createdAt));
  // Filtering by color is filtering by category: the two are the same choice (CATEGORY_FOR_COLOR).
  const shown = sorted.filter((h) => filter === "all" || h.color === filter);
  const lost = new Set(lostIds);
  const lostText = highlights.filter((h) => lost.has(h.id) && !h.rects).length;
  const tabs: [PanelTab, string][] = [
    ["highlights", t("panel.tabHighlights", { n: highlights.length })],
    ["notes", t("panel.tabNotes")],
    ["ai", t("panel.tabAi")],
    ["chat", t("panel.tabChat")],
  ];

  return (
    <aside
      aria-label={t("panel.aria")}
      className="fixed inset-y-0 right-0 z-20 flex w-full min-h-0 flex-col border-l border-line bg-surface shadow-pop sm:w-[380px] lg:static lg:z-auto lg:shadow-none"
    >
      <div className="flex h-[60px] shrink-0 items-center gap-1 border-b border-line pl-3 pr-2" role="tablist">
        {tabs.map(([value, label]) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={tab === value}
            onClick={() => onTab(value)}
            className={`h-10 rounded-[9px] px-3 text-sm ${tab === value ? "bg-soft font-semibold text-ink" : "text-muted hover:text-ink"}`}
          >
            {label}
          </button>
        ))}
        <span className="flex-1" />
        <button type="button" aria-label={t("panel.closePanel")} onClick={onClose} className="icon-btn text-muted">
          <Icon name="x" />
        </button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
        {tab === "highlights" && (
          <>
            {highlights.length > 0 && (
              <Link
                href={`/notebooks/new?document=${docId}`}
                className="flex items-center gap-2 rounded-lg border border-line px-3 py-2.5 text-sm font-medium text-ink transition-colors hover:bg-soft"
              >
                <Icon name="spark" size={16} className="text-accent" />
                <span className="flex-1">{t("panel.makeNotebook")}</span>
                <Icon name="next" size={16} className="text-muted" />
              </Link>
            )}
            {highlights.length > 0 && (
              <div aria-label={t("panel.filterAria")} className="flex flex-wrap gap-1.5">
                <button type="button" aria-pressed={filter === "all"} onClick={() => setFilter("all")} className="chip h-[34px] px-2.5 text-[13px]">
                  {t("panel.allCount", { n: highlights.length })}
                </button>
                {HIGHLIGHT_COLORS.map((c) => {
                  const count = highlights.filter((h) => h.color === c).length;
                  return (
                    <button
                      key={c}
                      type="button"
                      aria-pressed={filter === c}
                      onClick={() => setFilter(filter === c ? "all" : c)}
                      className="chip h-[34px] gap-1.5 px-2.5 text-[13px]"
                    >
                      <span className="h-2.5 w-2.5 rounded-full" style={{ background: COLOR_DOT[c] }} />
                      {colorLabel(labels, c, lang)} · {count}
                    </button>
                  );
                })}
              </div>
            )}
            {lostText > 0 && (
              <p className="rounded-lg bg-soft px-3 py-2.5 text-[13px] leading-normal text-muted">
                {t("panel.lostCount", { n: lostText })}
              </p>
            )}
            {!canHighlight && (
              <p className="rounded-lg bg-soft px-3 py-2.5 text-[13px] leading-normal text-muted">
                {t("panel.cleanOnly")}
              </p>
            )}
            {highlights.length === 0 ? (
              <p className="px-3 py-7 text-center text-sm leading-normal text-muted">
                {t("panel.empty")}
              </p>
            ) : shown.length === 0 ? (
              <p className="px-3 py-5 text-center text-sm leading-normal text-muted">
                {t("panel.noMatch")}
              </p>
            ) : (
              shown.map((h) => (
                <HighlightCard
                  key={h.id}
                  h={h}
                  active={h.id === activeId}
                  editing={h.id === editingId}
                  lost={lost.has(h.id)}
                  onJump={() => onJump(h)}
                  onEdit={() => onEditing(h.id)}
                  onDone={() => onEditing(null)}
                />
              ))
            )}
          </>
        )}

        {tab === "notes" && (
          <div className="flex flex-1 flex-col gap-2">
            <label className="flex flex-1 flex-col gap-2 text-sm font-medium text-ink">
              {t("panel.docNote")}
              <textarea
                value={draft}
                maxLength={20000}
                onChange={(e) => {
                  setDraft(e.target.value);
                  setStatus("dirty");
                }}
                onBlur={() => void saveNote(draft)}
                placeholder={t("panel.docNotePlaceholder")}
                className="min-h-[320px] flex-1 resize-none rounded-[10px] border border-line bg-bg px-3.5 py-3 font-serif text-base font-normal leading-relaxed text-ink outline-none focus:border-accent"
              />
            </label>
            <span className={`text-xs ${status === "error" ? "text-danger" : "text-muted"}`} aria-live="polite">
              {t("nb.chars", { n: draft.length })} ·{" "}
              {status === "saved" ? (
                t("common.saved")
              ) : status === "error" ? (
                <button type="button" className="underline" onClick={() => void saveNote(draft)}>
                  {t("panel.notSaved")}
                </button>
              ) : (
                t("common.saving")
              )}
            </span>
          </div>
        )}

        {tab === "ai" && <SummaryPanel docId={docId} onKeyword={onKeyword} />}

        {tab === "chat" && (
          <ChatPanel docId={docId} quote={aiQuote} onClearQuote={onClearQuote} onFind={onKeyword} />
        )}
      </div>
    </aside>
  );
}

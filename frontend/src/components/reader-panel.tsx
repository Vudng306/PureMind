"use client";

import { useSheet } from "./mobile-surfaces";
import { useEffect, useRef, useState } from "react";

import {
  CATEGORY_FOR_COLOR,
  MAX_HIGHLIGHT_NOTE,
  missingView,
  useHighlightActions,
  type AnchorIssue,
  type Highlight,
} from "@/lib/annotations";
import type { ChatImage } from "@/lib/chat";
import { useDocument, type SourceBox } from "@/lib/documents";
import { useLang, useT, type Key } from "@/lib/i18n";
import { MIND_MAP } from "@/lib/features";
import { MSG } from "@/lib/messages";
import { notebooksUsing } from "@/lib/notebooks";
import { useNotes } from "@/lib/notes";
import { COLOR_DOT, HIGHLIGHT_COLORS, colorLabel, usePreferences, type HighlightColor } from "@/lib/preferences";
import { findSnippet } from "@/lib/reader-ai";
import { useUi } from "@/lib/ui-store";

import { AiSummaryPanel } from "./ai-summary-panel";
import { ChatPanel } from "./chat-panel";
import { DocNotes } from "./doc-notes";
import { Icon } from "./icons";
import { MindMapPanel } from "./mind-map-panel";
import { ReaderInfo } from "./reader-info";
import { ConfirmDialog } from "./ui";

export type PanelTab = "info" | "highlights" | "notes" | "ai" | "mindmap" | "chat";

/** The panel's three tabs. Notes and AI each hold several of the views above, chosen inside the tab. */
export type PanelGroup = "info" | "notes" | "ai";
type Group = PanelGroup;
const GROUP: Record<PanelTab, Group> = {
  info: "info",
  highlights: "notes",
  notes: "notes",
  ai: "ai",
  mindmap: "ai",
  chat: "ai",
};
/** The tab of the panel a view is under. */
export const panelGroup = (tab: PanelTab): PanelGroup => GROUP[tab];

const GROUPS: [Group, Key][] = [
  ["info", "reader.tabInfo"],
  ["notes", "reader.tabNotes"],
  ["ai", "reader.tabAi"],
];

export function HighlightCard({
  h,
  active,
  editing,
  issue = null,
  stale = false,
  onJump,
  onFind,
  onEdit,
  onDone,
}: {
  h: Highlight;
  active: boolean;
  editing: boolean;
  /** Why it is not placed in the text shown now (AN-104); null when it is, or when nothing is shown. */
  issue?: AnchorIssue | null;
  /** Made on another extraction of the document than the one there is now. */
  stale?: boolean;
  onJump: () => void;
  /** Look for its words in the document, for one that is not placed. */
  onFind?: () => void;
  onEdit: () => void;
  onDone: () => void;
}) {
  const t = useT();
  const lang = useLang();
  const labels = usePreferences((s) => s.colorLabels);
  const showToast = useUi((s) => s.showToast);
  const { updateHighlight, removeHighlight, retryHighlight } = useHighlightActions();
  const ref = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState(h.note);
  const opened = useRef(h.note);
  const [confirm, setConfirm] = useState<"note" | "highlight" | null>(null);
  const [usedIn, setUsedIn] = useState(0);
  const missing = missingView(h);

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
      // AN-105: "saved" once the server has it; until then the card says it is being saved.
      updateHighlight(h.id, { note: draft }, { now: true, onSaved: () => showToast(t("panel.savedNote")) });
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
    removeHighlight(h.id, { onDone: () => showToast(t("highlights.deleted")) });
  }

  return (
    <div
      ref={ref}
      className={`flex flex-col gap-2.5 rounded-xl border p-3.5 transition-colors ${active ? "border-accent" : "border-line"}`}
    >
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
        <span className="flex h-6 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full bg-soft pl-1.5 pr-2 text-xs font-semibold text-ink">
          <span className="h-2.5 w-2.5 rounded-full" style={{ background: COLOR_DOT[h.color] }} />
          {colorLabel(labels, h.color, lang)}
        </span>
        {h.page ? <span className="whitespace-nowrap">{t("panel.pageN", { page: h.page })}</span> : null}
        <span className="flex-1" />
        <div className="highlight-colors flex items-center max-sm:basis-full max-sm:overflow-x-auto">
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
      </div>
      <button type="button" onClick={onJump} className="text-left font-serif text-base leading-normal text-ink hover:underline">
        “{h.text}”
      </button>
      {h.save === "saving" && (
        <p role="status" className="text-xs text-muted">
          {t("panel.saving")}
        </p>
      )}
      {h.save === "failed" && (
        <div role="alert" className="flex items-start gap-2 rounded-lg bg-danger-soft px-3 py-2 text-xs leading-normal text-danger">
          <span className="flex-1">
            {h.saveError ? `${h.saveError} ` : ""}
            {t("panel.saveFailed")}
          </span>
          {!h.saveError && (
            <button type="button" onClick={() => retryHighlight(h.id)} className="shrink-0 font-semibold underline">
              {t("common.retry")}
            </button>
          )}
        </div>
      )}
      {missing && !h.save && (
        <div className="flex flex-col items-start gap-1.5 rounded-lg bg-soft px-3 py-2 text-xs leading-normal text-muted">
          <p className="font-semibold text-ink">{t("panel.notSynced")}</p>
          <p>
            {t(missing === "clean" ? "panel.notSyncedClean" : "panel.notSyncedPdf")}
            {h.syncStatus === "ambiguous" ? ` ${t("panel.notSyncedAmbiguous")}` : ""}
          </p>
          <button type="button" onClick={onJump} className="font-semibold text-accent-text hover:underline">
            {t("panel.openSource")}
          </button>
        </div>
      )}
      {issue && missing !== "clean" && (
        <div className="flex flex-col items-start gap-1.5 rounded-lg bg-soft px-3 py-2 text-xs leading-normal text-muted">
          {issue === "review" && !h.rects && <p className="font-semibold text-ink">{t("panel.review")}</p>}
          <p>
            {h.rects ? t("panel.lostOriginal") : t(issue === "review" ? "panel.reviewText" : "panel.lostText")}
            {stale ? ` ${t("panel.otherVersion")}` : ""}
          </p>
          {onFind && !h.rects && (
            <button type="button" onClick={onFind} className="font-semibold text-accent-text hover:underline">
              {t("panel.findInText")}
            </button>
          )}
        </div>
      )}
      {editing ? (
        <div className="mobile-note-editor flex flex-col gap-2">
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
        <button type="button" onClick={onEdit} className="h-9 self-start text-sm font-medium text-accent-text hover:underline">
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
            updateHighlight(h.id, { note: "" }, { now: true, onSaved: () => showToast(t("panel.noteDeleted")) });
            setDraft("");
            onDone();
          } else {
            const said = h.note.trim() ? "panel.bothDeleted" : "highlights.deleted";
            removeHighlight(h.id, { onDone: () => showToast(t(said)) });
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

/** Right panel: about the document, its highlights and notes, and the AI summaries, mind map and chat. */
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
  aiImage,
  onClearImage,
  onKeyword,
  canHighlight,
  issues,
  progress,
  onSource,
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
  /** A figure the reader asked the AI to explain, shown in the chat tab. */
  aiImage: ChatImage | null;
  onClearImage: () => void;
  /** A summary keyword or a cited passage was chosen: find it in the document (FR-RDR-04). */
  onKeyword: (keyword: string) => void;
  canHighlight: boolean;
  /** Highlights not placed in the current text, and why (AN-104). */
  issues: Record<string, AnchorIssue>;
  /** How far the reader is right now, for the Info tab. */
  progress: string;
  /** Show a passage on the original PDF; left out for a document with no PDF. */
  onSource?: (boxes: SourceBox[]) => void;
}) {
  const t = useT();
  const lang = useLang();
  const labels = usePreferences((s) => s.colorLabels);
  const { data: doc } = useDocument(docId);
  const { data: notes } = useNotes(docId);
  const [filter, setFilter] = useState<HighlightColor | "all">("all");
  const sheet = useSheet(onClose);

  const sorted = [...highlights].sort((a, b) => (a.page ?? 0) - (b.page ?? 0) || a.createdAt.localeCompare(b.createdAt));
  // Filtering by color is filtering by category: the two are the same choice (CATEGORY_FOR_COLOR).
  const shown = sorted.filter((h) => filter === "all" || h.color === filter);
  const lostText = highlights.filter((h) => issues[h.id] && !h.rects).length;
  const version = doc?.content_version ?? null;
  const group = GROUP[tab];
  // Coming back to Notes or AI shows the view that was open there last.
  const lastIn = useRef<Record<Group, PanelTab>>({ info: "info", notes: "highlights", ai: "ai" });
  lastIn.current[group] = tab;
  const views: [PanelTab, string][] =
    group === "notes"
      ? [
          ["highlights", t("panel.tabHighlights", { n: highlights.length })],
          ["notes", t("notes.tab", { n: notes?.length ?? 0 })],
        ]
      : group === "ai"
        ? [
            ["ai", t("reader.subSummary")],
            ...(MIND_MAP ? ([["mindmap", t("ai.tabMap")]] as [PanelTab, string][]) : []),
            ["chat", t("panel.tabChat")],
          ]
        : [];

  return (
    <aside
      aria-label={t("panel.aria")}
      data-expanded={sheet.expanded}
      className="reader-sheet fixed inset-y-0 right-0 z-20 flex w-full min-h-0 flex-col border-l border-line bg-surface shadow-pop sm:w-[380px] lg:static lg:z-auto lg:shadow-none"
    >
      <button type="button" {...sheet.handle} aria-label={t("panel.aria")} aria-expanded={sheet.expanded} className="sheet-handle grid h-11 shrink-0 touch-none place-items-center sm:hidden">
        <span className="h-1 w-12 rounded-full bg-muted/40" />
      </button>
      <div className="flex h-14 shrink-0 items-center border-b border-line pl-4 pr-2">
        {/* Only the tabs are in the tab list; the close button beside them is not a tab (WCAG 4.1.2). */}
        <div className="flex h-14 items-center gap-5" role="tablist">
        {GROUPS.map(([value, label]) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={group === value}
            onClick={() => onTab(lastIn.current[value])}
            className={`-mb-px flex h-14 items-center gap-1.5 border-b-2 text-[15px] ${
              group === value ? "border-ink font-semibold text-ink" : "border-transparent text-muted hover:text-ink"
            }`}
          >
            {t(label)}
            {value === "notes" && highlights.length > 0 && (
              <span className="rounded-md bg-soft px-1.5 py-px text-xs font-medium tabular-nums text-body">{highlights.length}</span>
            )}
          </button>
        ))}
        </div>
        <span className="flex-1" />
        <button type="button" aria-label={t("panel.closePanel")} title={t("panel.closePanel")} onClick={onClose} className="icon-btn h-10 w-10 text-muted">
          <Icon name="panelRight" />
        </button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
        {group === "ai" ? (
          <div className="split shrink-0" role="group" aria-label={t("panel.aiViews")}>
            {views.map(([value, label]) => (
              <button key={value} type="button" aria-pressed={tab === value} onClick={() => onTab(value)}>
                <span className="truncate">{label}</span>
              </button>
            ))}
          </div>
        ) : views.length > 0 && (
          <div className="flex shrink-0 gap-1.5">
            {views.map(([value, label]) => (
              <button key={value} type="button" aria-pressed={tab === value} onClick={() => onTab(value)} className="chip h-[34px] px-3 text-[13px]">
                {label}
              </button>
            ))}
          </div>
        )}

        {tab === "info" && doc && <ReaderInfo doc={doc} progress={progress} onSummary={() => onTab("ai")} onSource={onSource} />}

        {tab === "highlights" && (
          <>
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
                  issue={issues[h.id] ?? null}
                  stale={Boolean(version && h.contentVersion && h.contentVersion !== version)}
                  onJump={() => onJump(h)}
                  onFind={() => onKeyword(findSnippet(h.text))}
                  onEdit={() => onEditing(h.id)}
                  onDone={() => onEditing(null)}
                />
              ))
            )}
          </>
        )}

        {tab === "notes" && <DocNotes docId={docId} onOpen={(c) => onKeyword(findSnippet(c.text))} />}

        {tab === "ai" && <AiSummaryPanel docId={docId} onFind={onKeyword} />}

        {tab === "mindmap" && MIND_MAP && <MindMapPanel docId={docId} onFind={onKeyword} />}

        {tab === "chat" && (
          <ChatPanel
            docId={docId}
            quote={aiQuote}
            onClearQuote={onClearQuote}
            image={aiImage}
            onClearImage={onClearImage}
            onFind={onKeyword}
          />
        )}
      </div>
    </aside>
  );
}

"use client";

import { useQueryClient } from "@tanstack/react-query";
import dynamic from "next/dynamic";
import Link from "next/link";
import { use, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { CleanReader, type CleanReaderHandle, type TextSelection } from "@/components/clean-reader";
import { FindBar } from "@/components/find-bar";
import { Icon } from "@/components/icons";
import type { PdfSelection, PdfViewerHandle } from "@/components/pdf-viewer";
import { ReaderPanel, type PanelTab } from "@/components/reader-panel";
import { SelectionMenu } from "@/components/selection-menu";
import { Alert, Spinner } from "@/components/ui";
import {
  CATEGORY_FOR_COLOR,
  MAX_SELECTION,
  flushHighlightEdits,
  useHighlightActions,
  useHighlights,
  type Highlight,
} from "@/lib/annotations";
import { KIND_LABEL, origin } from "@/lib/doc-view";
import { documentsKey, updateDocument, useDocument } from "@/lib/documents";
import { currentLang, translate, useLang, useT, type Key } from "@/lib/i18n";
import { parseMarkdown, type Inline } from "@/lib/markdown";
import { MSG, messageFor } from "@/lib/messages";
import {
  colorLabel,
  usePreferences,
  type ColumnWidth,
  type HighlightColor,
  type LineHeight,
} from "@/lib/preferences";
import type { Theme } from "@/lib/types";
import { useUi } from "@/lib/ui-store";

const PdfViewer = dynamic(() => import("@/components/pdf-viewer").then((m) => m.PdfViewer), {
  ssr: false,
  // Outside React, so it reads the language at the moment the chunk starts loading.
  loading: () => (
    <div className="p-6">
      <Spinner label={translate(currentLang(), "reader.opening")} />
    </div>
  ),
});

type Mode = "original" | "clean";
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
const WIDTHS: [ColumnWidth, Key][] = [
  [600, "settings.widthNarrow"],
  [680, "settings.widthMedium"],
  [780, "settings.widthWide"],
];
const TOOLBAR_SPACE = 120;
const inlineText = (nodes: Inline[]): string => nodes.map((n) => ("v" in n ? n.v : inlineText(n.c))).join("");
const modeKey = (id: string) => `puremind-reader-mode:${id}`;

function readStoredMode(id: string): Mode | null {
  try {
    const v = localStorage.getItem(modeKey(id));
    return v === "original" || v === "clean" ? v : null;
  } catch {
    return null;
  }
}

export default function ReaderPage({ params }: { params: Promise<{ id: string }> }) {
  const t = useT();
  const lang = useLang();
  const { id } = use(params);
  const { data: doc, isLoading, isError, error } = useDocument(id);
  const { theme, fontSize, lineHeight, width, defaultMode, colorLabels, set: setPrefs } = usePreferences();
  const showToast = useUi((s) => s.showToast);
  const qc = useQueryClient();
  const { data: highlights, isPending: highlightsPending } = useHighlights(id);
  const { addHighlight, updateHighlight } = useHighlightActions();

  const [viewerError, setViewerError] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [mode, setMode] = useState<Mode | null>(null);
  const [findOpen, setFindOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [matchIndex, setMatchIndex] = useState(0);
  const [matchTotal, setMatchTotal] = useState(0);
  const [focus, setFocus] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const [panelTab, setPanelTab] = useState<PanelTab>("highlights");
  const [tocOpen, setTocOpen] = useState(false);
  // FR-RDR-03: the reading options live behind this gear, so the toolbar stays short.
  const [optsOpen, setOptsOpen] = useState(false);
  const [activeHl, setActiveHl] = useState<string | null>(null);
  const [flashHl, setFlashHl] = useState<string | null>(null);
  const [lostHl, setLostHl] = useState<string[]>([]);
  const [editingHl, setEditingHl] = useState<string | null>(null);
  const [aiQuote, setAiQuote] = useState<string | null>(null);
  const [selection, setSelection] = useState<TextSelection | PdfSelection | null>(null);
  // The highlight a ?hl= link points at; it decides the mode the reader opens in.
  const [hlTarget, setHlTarget] = useState<Highlight | null>(null);
  const [fraction, setFraction] = useState(0);
  const [page, setPage] = useState<{ current: number; total: number } | null>(null);

  const readerRef = useRef<CleanReaderHandle>(null);
  const pdfRef = useRef<PdfViewerHandle>(null);
  const modeChosen = useRef(false);
  const pendingJump = useRef<Highlight | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const progressTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const pendingFraction = useRef<number | null>(null);
  const markedRead = useRef(false);
  const restored = useRef(false);

  const isPdf = doc?.file_type === "pdf";
  const hasClean = doc?.extraction_status === "done" && Boolean(doc.content_clean);
  // Non-PDF documents only exist as clean text (FR-RDR-01 step 4).
  const effectiveMode: Mode = !isPdf ? "clean" : mode === "clean" && hasClean ? "clean" : "original";
  const clean = effectiveMode === "clean" && hasClean;

  const blocks = useMemo(() => {
    const all = doc?.content_clean ? parseMarkdown(doc.content_clean) : [];
    return isPdf ? all : all.filter((b) => b.t !== "pagebreak");
  }, [doc?.content_clean, isPdf]);

  // Page of every block (pagebreak markers start the next page).
  const blockPage = useMemo(() => {
    const map = new Map<string, number>();
    let p = 1;
    for (const b of blocks) {
      if (b.t === "pagebreak") p = b.page;
      else map.set(b.id, p);
    }
    return map;
  }, [blocks]);
  const hasPages = isPdf && blocks.some((b) => b.t === "pagebreak");
  const headings = blocks.filter((b) => b.t === "heading");

  // FR-RDR-03: the theme picked here is for this sitting only. It starts from the theme of the app, and the
  // app's theme comes back when the reader is closed — so leaving and opening another document look the same
  // as the rest of PureMind. The lasting choice is the one in the settings.
  const [readingTheme, setReadingTheme] = useState<Theme>(theme);
  useEffect(() => setReadingTheme(theme), [theme]);
  useEffect(() => {
    document.documentElement.dataset.theme = readingTheme;
    return () => {
      document.documentElement.dataset.theme = theme;
    };
  }, [readingTheme, theme]);

  useEffect(() => {
    if (modeChosen.current) return;
    const params = new URLSearchParams(window.location.search);
    const hlId = params.get("hl");
    if (hlId && highlightsPending) return; // wait to know where that highlight was made
    modeChosen.current = true;
    const target = hlId ? (highlights.find((h) => h.id === hlId) ?? null) : null;
    setHlTarget(target);
    // A link to a highlight opens the view it was made in: the PDF page or the clean text.
    setMode(target ? (target.blockId === null ? "original" : "clean") : hlId ? "clean" : (readStoredMode(id) ?? defaultMode));
    // A summary found by search opens the summary panel (FR-SRCH-01 step 6).
    if (params.get("panel") === "summary") {
      setPanelOpen(true);
      setPanelTab("ai");
    }
    // A link from search results opens in-document find with the same words.
    const q = params.get("q")?.trim();
    if (q) {
      setQuery(q);
      setFindOpen(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, highlightsPending, highlights]);

  const flashTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(flashTimer.current), []);

  const onUnanchored = useCallback(
    (ids: string[]) => setLostHl((prev) => (prev.join() === ids.join() ? prev : ids)),
    [],
  );

  // FR-HL-01: selections longer than 5,000 characters cannot be highlighted.
  const onSelect = useCallback(
    (s: TextSelection | PdfSelection | null) => {
      if (s && s.text.length > MAX_SELECTION) {
        showToast(MSG["MSG-22"]);
        return setSelection(null);
      }
      setSelection(s);
    },
    [showToast],
  );

  function chooseMode(next: Mode) {
    setMode(next);
    setSelection(null);
    setTocOpen(false);
    restored.current = false;
    try {
      localStorage.setItem(modeKey(id), next); // FR-RDR-05 step 4: remembered per document on this device
    } catch {
      /* storage unavailable */
    }
  }

  // Keyboard: Ctrl+F opens in-document search; Esc leaves focus mode / closes the table of contents.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
        e.preventDefault();
        setFindOpen(true);
      } else if (e.key === "Escape") {
        setTocOpen(false);
        setFocus(false);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const onQuery = (q: string) => {
    setQuery(q);
    setMatchIndex(0);
  };
  const onResult = useCallback((n: number) => setMatchTotal(n), []);
  const search = { query: findOpen ? query : "", index: matchIndex, onResult };

  // FR-DOC-07 step 3: save position (debounced 2 s); mark as read on the last page.
  const onPageChange = useCallback(
    (current: number, total: number) => {
      setPage({ current, total });
      clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => {
        const patch: { last_read_page: number; is_read?: boolean } = { last_read_page: current };
        if (current === total && !markedRead.current && !doc?.is_read) {
          patch.is_read = true;
          markedRead.current = true;
        }
        updateDocument(id, patch).catch(() => undefined);
      }, 2000);
    },
    [id, doc?.is_read],
  );

  // Clean-text position: saved 1.5 s after scrolling stops, and when leaving the page.
  const sendFraction = useCallback(() => {
    clearTimeout(progressTimer.current);
    const f = pendingFraction.current;
    if (f === null) return;
    pendingFraction.current = null;
    const patch: { read_fraction: number; is_read?: boolean } = { read_fraction: Math.round(f * 10000) / 10000 };
    if (!isPdf && f >= 0.98 && !markedRead.current && !doc?.is_read) {
      markedRead.current = true;
      patch.is_read = true;
    }
    updateDocument(id, patch).catch(() => undefined);
  }, [id, isPdf, doc?.is_read]);

  const onScrollProgress = useCallback(
    (f: number, cleanPage: number | null) => {
      setFraction(f);
      pendingFraction.current = f;
      clearTimeout(progressTimer.current);
      progressTimer.current = setTimeout(sendFraction, 1500);
      if (cleanPage !== null && doc?.page_count) onPageChange(cleanPage, doc.page_count);
    },
    [doc?.page_count, sendFraction, onPageChange],
  );

  const sendFractionRef = useRef(sendFraction);
  sendFractionRef.current = sendFraction;
  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === "hidden") sendFractionRef.current();
    };
    document.addEventListener("visibilitychange", onHide);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      clearTimeout(saveTimer.current);
      sendFractionRef.current();
      flushHighlightEdits();
      // The library shows progress and "continue reading" from these values.
      void qc.invalidateQueries({ queryKey: [...documentsKey, "list"] });
    };
  }, [qc]);

  const jumpTo = useCallback((h: Highlight) => {
    setActiveHl(h.id);
    if (!readerRef.current?.scrollToHighlight(h) && h.blockId) {
      readerRef.current?.scrollToBlock(h.blockId);
    }
  }, []);

  const flash = useCallback((hlId: string) => {
    clearTimeout(flashTimer.current);
    setFlashHl(hlId);
    flashTimer.current = setTimeout(() => setFlashHl(null), 1600);
  }, []);

  // Restore the clean-text position once: a highlight from the panel or ?hl=, otherwise where the reader left off.
  useEffect(() => {
    if (!clean || restored.current || !blocks.length || highlightsPending) return;
    restored.current = true;
    requestAnimationFrame(() => {
      const hlId = new URLSearchParams(window.location.search).get("hl");
      const target = pendingJump.current ?? (hlId ? highlights.find((h) => h.id === hlId) : undefined);
      pendingJump.current = null;
      if (target) {
        setPanelOpen(true);
        setPanelTab("highlights");
        jumpTo(target);
        flash(target.id);
      } else if (doc?.read_fraction && doc.read_fraction < 0.98) {
        readerRef.current?.scrollToFraction(doc.read_fraction);
      }
    });
  }, [clean, blocks.length, highlights, highlightsPending, doc?.read_fraction, jumpTo, flash]);

  // Same for the original PDF: go to the linked highlight once the document has loaded.
  useEffect(() => {
    if (effectiveMode !== "original" || restored.current) return;
    const target = pendingJump.current ?? hlTarget;
    if (!target) return;
    restored.current = true;
    pendingJump.current = null;
    setPanelOpen(true);
    setPanelTab("highlights");
    setActiveHl(target.id);
    flash(target.id);
    let tries = 0;
    const timer = setInterval(() => {
      if (pdfRef.current?.scrollToHighlight(target) || ++tries > 40) clearInterval(timer);
    }, 150);
    return () => clearInterval(timer);
  }, [effectiveMode, hlTarget, flash]);

  function openHighlight(h: Highlight) {
    if (effectiveMode === "original") {
      setActiveHl(h.id);
      if (pdfRef.current?.scrollToHighlight(h)) return flash(h.id);
      // Not placed on the PDF (e.g. made in the clean text of a page it cannot be found on).
      if (!hasClean) return;
      pendingJump.current = h;
      return chooseMode("clean");
    }
    jumpTo(h);
    flash(h.id);
  }

  // ---- selection actions
  const clearSelection = useCallback(() => {
    window.getSelection()?.removeAllRanges();
    setSelection(null);
  }, []);

  function highlightSelection(color: HighlightColor, note = false): Highlight | null {
    if (!selection) return null;
    const sel = selection;
    const onPdf = "rects" in sel;
    const existing = highlights.find((h) =>
      onPdf
        ? h.rects !== null && h.page === sel.page && h.text === sel.text
        : h.blockId === sel.blockId && h.start === sel.start && h.end === sel.end,
    );
    let h: Highlight;
    if (existing) {
      const category = CATEGORY_FOR_COLOR[color];
      updateHighlight(existing.id, { color, category });
      h = { ...existing, color, category };
    } else if (onPdf) {
      // FR-HL-01 step 2: on the original page the position is the page plus normalised rectangles.
      h = addHighlight({
        docId: id,
        blockId: null,
        start: null,
        end: null,
        rects: sel.rects,
        text: sel.text,
        color,
        category: CATEGORY_FOR_COLOR[color],
        page: sel.page,
      });
    } else {
      h = addHighlight({
        docId: id,
        blockId: sel.blockId,
        start: sel.start,
        end: sel.end,
        rects: null,
        text: sel.text,
        color,
        category: CATEGORY_FOR_COLOR[color],
        page: hasPages ? (blockPage.get(sel.blockId) ?? null) : null,
      });
    }
    clearSelection();
    setActiveHl(h.id);
    if (note) {
      setPanelOpen(true);
      setPanelTab("highlights");
      setEditingHl(h.id);
    } else {
      showToast(t("reader.highlighted", { name: colorLabel(colorLabels, color, lang) }));
    }
    return h;
  }

  async function copySelection() {
    if (!selection) return;
    try {
      await navigator.clipboard.writeText(selection.text);
      showToast(t("reader.quoteCopied"));
    } catch {
      showToast(t("reader.copyFailed"));
    }
    clearSelection();
  }

  // FR-RDR-06 / FR-CHAT-02: ask the chat about the selected passage.
  function explainSelection() {
    if (!selection) return;
    setAiQuote(selection.text);
    setPanelOpen(true);
    setPanelTab("chat");
    clearSelection();
  }

  // A summary keyword opens in-document find (FR-SUM-01 output, FR-RDR-04).
  function findKeyword(keyword: string) {
    onQuery(keyword);
    setFindOpen(true);
  }

  const onHighlightClick = useCallback((hlId: string) => {
    setActiveHl(hlId);
    setPanelOpen(true);
    setPanelTab("highlights");
  }, []);

  // ---- render
  if (isLoading || mode === null) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Spinner label={t("reader.opening")} />
      </div>
    );
  }

  if (isError || !doc || viewerError) {
    return (
      <div className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-4 px-4">
        <Alert>{isError && error instanceof Error ? error.message : MSG["MSG-21"]}</Alert>
        <div className="flex gap-2">
          {viewerError && (
            <button
              type="button"
              className="btn-primary"
              onClick={() => {
                setViewerError(false);
                setReloadKey((k) => k + 1);
              }}
            >
              {t("common.retry")}
            </button>
          )}
          <Link href="/library" className="btn-outline">
            {t("reader.backToLibrary")}
          </Link>
        </div>
      </div>
    );
  }

  const pct = effectiveMode === "original" && page ? page.current / page.total : fraction;
  const pageLabel =
    effectiveMode === "original" || hasPages
      ? page
        ? t("reader.pageOfTotal", { current: page.current, total: page.total })
        : doc.page_count
          ? t("reader.pagesCount", { n: doc.page_count })
          : ""
      : doc.reading_minutes
        ? t("reader.pctRemaining", {
            pct: Math.round(fraction * 100),
            n: Math.max(1, Math.round(doc.reading_minutes * (1 - fraction))),
          })
        : `${Math.round(fraction * 100)}%`;

  const header = (
    <>
      <div className="font-sans text-[13px] tracking-[0.06em] text-muted">
        {KIND_LABEL[doc.file_type]} · {origin(doc, lang)}
        {doc.reading_minutes ? ` · ${t("common.minutesRead", { n: doc.reading_minutes })}` : ""}
      </div>
      <h1 className="mb-7 mt-2.5 text-[1.9em] font-medium leading-[1.1] text-ink">{doc.title}</h1>
    </>
  );

  const toolBtn = "flex h-11 items-center gap-2 rounded-[10px] px-3 text-sm text-ink hover:bg-soft disabled:cursor-not-allowed disabled:opacity-40";
  const divider = <span className="hidden h-6 w-px bg-line sm:block" />;

  return (
    <div className="flex h-screen flex-col bg-bg text-ink">
      <div aria-hidden className="h-[3px] shrink-0 bg-line">
        <div className="h-[3px] bg-accent transition-[width] duration-200" style={{ width: `${Math.round(pct * 100)}%` }} />
      </div>

      {!focus && (
        <header className="flex h-16 shrink-0 items-center gap-2 border-b border-line px-2 sm:gap-3.5 sm:px-5">
          <Link href="/library" className="flex h-11 items-center gap-1 rounded-[10px] pl-1.5 pr-3 text-[15px] hover:bg-soft" aria-label={t("reader.backToLibrary")}>
            <Icon name="back" size={20} />
            <span className="hidden sm:inline">{t("nav.library")}</span>
          </Link>
          <span className="hidden h-6 w-px bg-line sm:block" />
          <div className="flex min-w-0 flex-1 flex-col gap-0.5 lg:max-w-[360px]">
            <span className="truncate text-[15px] font-semibold">{doc.title}</span>
            <span className="truncate text-xs text-muted">
              {KIND_LABEL[doc.file_type]}
              {pageLabel ? ` · ${pageLabel}` : ""}
            </span>
          </div>
          <span className="hidden flex-1 lg:block" />
          {isPdf && (
            <div className="hidden h-11 gap-0.5 rounded-xl bg-soft p-1 md:flex" role="group" aria-label={t("reader.modeAria")}>
              {(["clean", "original"] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  aria-pressed={effectiveMode === m}
                  disabled={m === "clean" && !hasClean}
                  title={m === "clean" && !hasClean ? messageFor(doc.extraction_error) : undefined}
                  onClick={() => chooseMode(m)}
                  className={`h-9 rounded-[9px] px-4 text-sm disabled:cursor-not-allowed disabled:opacity-40 ${
                    effectiveMode === m ? "bg-surface font-semibold text-ink shadow-sm" : "text-muted hover:text-ink"
                  }`}
                >
                  {t(m === "original" ? "reader.original" : "reader.clean")}
                </button>
              ))}
            </div>
          )}
          <span className="hidden flex-1 lg:block" />
          <div className="flex justify-end gap-2 lg:w-[360px]">
            <button
              type="button"
              onClick={() => {
                const open = !(panelOpen && panelTab === "ai");
                setPanelOpen(open);
                if (open) setPanelTab("ai");
              }}
              aria-pressed={panelOpen && panelTab === "ai"}
              className={`flex h-11 items-center gap-2 rounded-[10px] border border-line px-3.5 text-sm font-medium ${panelOpen && panelTab === "ai" ? "bg-soft" : "hover:bg-soft"}`}
            >
              <Icon name="spark" />
              <span className="hidden sm:inline">{t("panel.tabAi")}</span>
            </button>
            <button
              type="button"
              onClick={() => {
                const open = !(panelOpen && panelTab !== "ai");
                setPanelOpen(open);
                if (open && panelTab === "ai") setPanelTab("highlights");
              }}
              aria-pressed={panelOpen && panelTab !== "ai"}
              className={`flex h-11 items-center gap-2 rounded-[10px] border border-line px-3.5 text-sm font-medium ${panelOpen && panelTab !== "ai" ? "bg-soft" : "hover:bg-soft"}`}
            >
              <Icon name="highlighter" />
              <span className="hidden sm:inline">{t("reader.highlightsShort")}</span> {highlights.length}
            </button>
          </div>
        </header>
      )}

      <div className="flex min-h-0 flex-1">
        <div className="relative flex min-w-0 flex-1 flex-col">
          {effectiveMode === "original" ? (
            <>
              {doc.extraction_status === "failed" && (
                <div className="mx-auto w-full max-w-[640px] px-4 pt-4">
                  <Alert>{messageFor(doc.extraction_error)}</Alert>
                </div>
              )}
              {isPdf && (
                <div className="flex justify-center border-b border-line py-2 md:hidden">
                  <button type="button" className="chip h-9" onClick={() => chooseMode("clean")} disabled={!hasClean}>
                    {t("reader.switchClean")}
                  </button>
                </div>
              )}
              <PdfViewer
                handleRef={pdfRef}
                documentId={doc.id}
                initialPage={hlTarget?.page ?? doc.last_read_page ?? 1}
                onPageChange={onPageChange}
                onError={() => setViewerError(true)}
                reloadKey={reloadKey}
                search={search}
                bottomInset={focus ? 24 : TOOLBAR_SPACE}
                highlights={highlights}
                activeHighlightId={activeHl}
                flashHighlightId={flashHl}
                onSelect={onSelect}
                onHighlightClick={onHighlightClick}
              />
            </>
          ) : hasClean ? (
            <>
              {isPdf && (
                <div className="flex justify-center border-b border-line py-2 md:hidden">
                  <button type="button" className="chip h-9" onClick={() => chooseMode("original")}>
                    {t("reader.viewOriginal")}
                  </button>
                </div>
              )}
              <div className="min-h-0 flex-1">
                <CleanReader
                  handleRef={readerRef}
                  header={header}
                  blocks={blocks}
                  fontSize={fontSize}
                  lineHeight={lineHeight}
                  width={width}
                  search={search}
                  highlights={highlights}
                  activeHighlightId={activeHl}
                  flashHighlightId={flashHl}
                  onSelect={onSelect}
                  onHighlightClick={onHighlightClick}
                  onUnanchored={onUnanchored}
                  onScrollProgress={onScrollProgress}
                  bottomPadding={focus ? 80 : 170}
                />
              </div>
            </>
          ) : doc.extraction_status === "failed" ? (
            <div className="mx-auto flex max-w-md flex-1 flex-col justify-center gap-4 px-4">
              <Alert>{messageFor(doc.extraction_error)}</Alert>
              <Link href="/library" className="btn-outline self-start">
                {t("reader.backToLibrary")}
              </Link>
            </div>
          ) : (
            <div className="flex flex-1 items-center justify-center">
              <Spinner label={t("reader.extracting")} />
            </div>
          )}

          {findOpen && (
            <FindBar
              query={query}
              onQuery={onQuery}
              index={matchIndex}
              total={matchTotal}
              onIndex={setMatchIndex}
              onClose={() => setFindOpen(false)}
            />
          )}

          {optsOpen && !focus && (
            <div
              role="dialog"
              aria-label={t("settings.readingOptions")}
              className="absolute bottom-[96px] left-1/2 z-20 flex w-[min(360px,calc(100%-24px))] -translate-x-1/2 flex-col gap-4 rounded-[14px] border border-line bg-surface p-4 shadow-float"
            >
              <div className="flex flex-col gap-2">
                <span className="text-[13px] font-semibold text-muted">{t("reader.themeAria")}</span>
                <div className="flex items-center gap-1" role="radiogroup" aria-label={t("reader.themeAria")}>
                  {THEMES.map((th) => (
                    <button
                      key={th.value}
                      type="button"
                      role="radio"
                      aria-checked={readingTheme === th.value}
                      title={t(th.label)}
                      onClick={() => setReadingTheme(th.value)}
                      className="flex h-11 flex-1 items-center justify-center gap-2 rounded-[10px] border border-line text-[13px] text-ink hover:bg-soft"
                      style={{ borderColor: readingTheme === th.value ? "rgb(var(--accent))" : undefined }}
                    >
                      <span className="h-[18px] w-[18px] rounded-full border border-line" style={{ background: th.swatch }} />
                      {t(th.label)}
                    </button>
                  ))}
                </div>
              </div>
              {clean && (
                <>
                  <div className="flex flex-col gap-2">
                    <span className="text-[13px] font-semibold text-muted">{t("settings.lineHeight")}</span>
                    <div className="flex gap-1.5" role="radiogroup" aria-label={t("settings.lineHeight")}>
                      {LINE_HEIGHTS.map(([v, l]) => (
                        <button
                          key={v}
                          type="button"
                          role="radio"
                          aria-checked={lineHeight === v}
                          className="chip flex-1"
                          onClick={() => setPrefs({ lineHeight: v })}
                        >
                          {t(l)}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="flex flex-col gap-2">
                    <span className="text-[13px] font-semibold text-muted">{t("settings.columnWidth")}</span>
                    <div className="flex gap-1.5" role="radiogroup" aria-label={t("settings.columnWidth")}>
                      {WIDTHS.map(([v, l]) => (
                        <button
                          key={v}
                          type="button"
                          role="radio"
                          aria-checked={width === v}
                          className="chip flex-1"
                          onClick={() => setPrefs({ width: v })}
                        >
                          {t(l)}
                        </button>
                      ))}
                    </div>
                  </div>
                </>
              )}
              <Link href="/settings" className="flex items-center gap-1.5 text-[13px] text-accent hover:underline">
                <Icon name="gear" size={14} />
                {t("settings.allOptions")}
              </Link>
            </div>
          )}

          {tocOpen && !focus && (
            <div
              role="dialog"
              aria-label={t("reader.outline")}
              className="absolute bottom-[96px] left-1/2 z-20 flex max-h-[60vh] w-[min(360px,calc(100%-24px))] -translate-x-1/2 flex-col gap-0.5 overflow-y-auto rounded-[14px] border border-line bg-surface p-2.5 shadow-float"
            >
              <span className="px-2.5 py-2 text-xs font-semibold tracking-[0.08em] text-muted">{t("reader.outlineHeading")}</span>
              {headings.length === 0 ? (
                <p className="px-2.5 pb-2 text-sm text-muted">{t("reader.noHeadings")}</p>
              ) : (
                headings.map((hd) => (
                  <button
                    key={hd.id}
                    type="button"
                    onClick={() => {
                      readerRef.current?.scrollToBlock(hd.id);
                      setTocOpen(false);
                    }}
                    className="flex min-h-11 items-center justify-between gap-3 rounded-[9px] px-2.5 py-2 text-left text-sm text-ink hover:bg-soft"
                    style={{ paddingLeft: hd.t === "heading" ? 10 + (hd.level - 1) * 14 : 10 }}
                  >
                    <span className="line-clamp-2">
                      {hd.t === "heading" && inlineText(hd.c)}
                    </span>
                    {hasPages && <span className="shrink-0 text-[13px] text-muted">{blockPage.get(hd.id)}</span>}
                  </button>
                ))
              )}
            </div>
          )}

          {!focus ? (
            <nav
              aria-label={t("reader.tools")}
              className="absolute bottom-3 left-1/2 z-10 flex h-[60px] w-[min(640px,calc(100%-16px))] -translate-x-1/2 items-center justify-between gap-0.5 rounded-[18px] border border-line bg-surface px-2 shadow-float sm:bottom-6"
            >
              <button
                type="button"
                className={toolBtn}
                onClick={() => {
                  setTocOpen((o) => !o);
                  setOptsOpen(false);
                }}
                disabled={!clean}
                aria-expanded={tocOpen}
              >
                <Icon name="toc" />
                <span className="hidden sm:inline">{t("reader.outline")}</span>
              </button>
              <button type="button" className="icon-btn" aria-label={t("reader.findCtrlF")} onClick={() => setFindOpen((o) => !o)} aria-expanded={findOpen}>
                <Icon name="search" />
              </button>
              {divider}
              {clean && (
                <>
                  <div className="flex items-center">
                    <button
                      type="button"
                      aria-label={t("reader.textSmaller")}
                      className="icon-btn font-serif text-[15px]"
                      disabled={fontSize <= 14}
                      onClick={() => setPrefs({ fontSize: fontSize - 1 })}
                    >
                      A
                    </button>
                    <span className="w-[34px] text-center text-[13px] text-muted" aria-live="polite">
                      {fontSize}
                    </span>
                    <button
                      type="button"
                      aria-label={t("reader.textBigger")}
                      className="icon-btn font-serif text-[21px]"
                      disabled={fontSize >= 28}
                      onClick={() => setPrefs({ fontSize: fontSize + 1 })}
                    >
                      A
                    </button>
                  </div>
                  {divider}
                </>
              )}
              <button
                type="button"
                className="icon-btn"
                aria-label={t("settings.readingOptions")}
                onClick={() => {
                  setOptsOpen((o) => !o);
                  setTocOpen(false);
                }}
                aria-expanded={optsOpen}
              >
                <Icon name="gear" />
              </button>
              {divider}
              <button
                type="button"
                className={toolBtn}
                onClick={() => {
                  setFocus(true);
                  setTocOpen(false);
                  setSelection(null);
                }}
              >
                <Icon name="focus" />
                <span className="hidden sm:inline">{t("reader.focus")}</span>
              </button>
            </nav>
          ) : (
            <button
              type="button"
              onClick={() => setFocus(false)}
              className="absolute right-4 top-4 z-10 flex h-11 items-center gap-2 rounded-full border border-line bg-surface px-4 text-sm text-muted opacity-60 transition-opacity hover:opacity-100 focus-visible:opacity-100"
            >
              <Icon name="x" size={16} />
              {t("reader.exitFocus")}
            </button>
          )}
        </div>

        {panelOpen && !focus && (
          <ReaderPanel
            docId={id}
            highlights={highlights}
            tab={panelTab}
            onTab={setPanelTab}
            onClose={() => setPanelOpen(false)}
            activeId={activeHl}
            editingId={editingHl}
            onEditing={setEditingHl}
            onJump={openHighlight}
            aiQuote={aiQuote}
            onClearQuote={() => setAiQuote(null)}
            onKeyword={findKeyword}
            canHighlight={clean || isPdf}
            lostIds={clean ? lostHl : []}
          />
        )}
      </div>

      {selection && (clean || "rects" in selection) && (
        <SelectionMenu
          selection={selection}
          onColor={(c) => highlightSelection(c)}
          onNote={() => highlightSelection("yellow", true)}
          onCopy={copySelection}
          onExplain={explainSelection}
          onDismiss={() => setSelection(null)}
        />
      )}
    </div>
  );
}

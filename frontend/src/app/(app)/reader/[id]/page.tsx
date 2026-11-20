"use client";

import { useQueryClient } from "@tanstack/react-query";
import dynamic from "next/dynamic";
import Link from "next/link";
import { use, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ActionSheet, BottomSheet, type SheetAction } from "@/components/bottom-sheet";
import { CleanReader, type CleanReaderHandle, type ScrollState, type TextSelection } from "@/components/clean-reader";
import { FindBar } from "@/components/find-bar";
import { Icon } from "@/components/icons";
import type { PdfSelection, PdfViewerHandle } from "@/components/pdf-viewer";
import { ArticleEnd, AsideAuthors } from "@/components/reader-aside";
import { IntegrityNotice, ResumeChip } from "@/components/reader-notices";
import { ReaderPanel, panelGroup, type PanelTab } from "@/components/reader-panel";
import { SelectionMenu } from "@/components/selection-menu";
import { NotePopover } from "@/components/note-popover";
import { TranslatePopover } from "@/components/translate-popover";
import { Alert, Spinner } from "@/components/ui";
import {
  CATEGORY_FOR_COLOR,
  MAX_SELECTION,
  flushHighlightEdits,
  missingView,
  pdfPlaces,
  samePassage,
  useHighlightActions,
  useHighlights,
  viewFor,
  type AnchorIssue,
  type Highlight,
} from "@/lib/annotations";
import { useAside } from "@/lib/aside";
import type { ChatImage } from "@/lib/chat";
import { KIND_LABEL, origin } from "@/lib/doc-view";
import {
  documentsKey,
  updateDocument,
  useCharts,
  useDocument,
  useDocuments,
  useReprocessOutcome,
  useSourceMap,
  type SourceBox,
} from "@/lib/documents";
import { currentLang, translate, useLang, useT, type Key } from "@/lib/i18n";
import { SELECTION_EXPLAIN, SELECTION_TRANSLATE } from "@/lib/features";
import { parseMarkdown } from "@/lib/markdown";
import { MSG, messageFor } from "@/lib/messages";
import { BOTTOM_BAR, PhoneReaderBars, ReaderOutline, ReadingOptions, TOP_BAR } from "@/components/reader-controls";
import { followScroll, useCompact, type BarsState } from "@/lib/mobile";
import { colorLabel, usePreferences, type HighlightColor } from "@/lib/preferences";
import { readOn, readOnPages, resumeOf, toPosition, type Resume } from "@/lib/reading";
import type { DocumentDetail, DocumentListItem, ReadPosition, Theme } from "@/lib/types";
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
// Whether each column beside the text was left open, on this device. Until the reader opens one, both are
// closed: a document opens as text and nothing else (RD-101).
const SIDE_KEY = "puremind-reader-side";
const PANEL_KEY = "puremind-reader-panel";
const WIDE = "(min-width: 1280px)";
// How long a selection is waited for after a press on the phone's bar, and a scroll is taken as the reader's own.
const MENU_HOLD_MS = 450;
const TOUCH_SCROLL_MS = 1500;
const modeKey = (id: string) => `puremind-reader-mode:${id}`;
const NO_ISSUES: Record<string, AnchorIssue> = {};

function readStoredMode(id: string): Mode | null {
  try {
    const v = localStorage.getItem(modeKey(id));
    return v === "original" || v === "clean" ? v : null;
  } catch {
    return null;
  }
}

function readFlag(key: string): boolean | null {
  try {
    const v = localStorage.getItem(key);
    return v === "1" ? true : v === "0" ? false : null;
  } catch {
    return null;
  }
}

function writeFlag(key: string, on: boolean) {
  try {
    localStorage.setItem(key, on ? "1" : "0");
  } catch {
    /* storage unavailable */
  }
}

/** A visit in progress: where it landed (once the jump has come to rest) and where it set out from. */
interface Visit {
  landTop: number | null;
  landPage: number | null;
  from: { original: boolean; top: number; page: number | null } | null;
}

/** Going from one document to the next keeps the route, so the reader is made anew for each document. */
export default function ReaderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return <Reader key={id} id={id} />;
}

function Reader({ id }: { id: string }) {
  const t = useT();
  const lang = useLang();
  const { data: doc, isLoading, isError, error } = useDocument(id);
  const {
    theme,
    fontSize,
    lineHeight,
    width,
    fontFamily,
    readingTheme: savedTheme,
    defaultMode,
    colorLabels,
    timeLeft,
  } = usePreferences();
  const showToast = useUi((s) => s.showToast);
  const setPageTheme = useUi((s) => s.setPageTheme);
  // UC-04: once a reading-again of the file ends, how the highlights fared, or that the text is kept.
  useReprocessOutcome(
    doc,
    useCallback(
      (outcome: "done" | "failed", report: DocumentDetail["reprocess_report"]) => {
        if (outcome === "failed") return showToast(t("reprocess.failed"));
        const a = report?.anchors;
        const review = a ? a.ambiguous + a.unresolved : 0;
        showToast(a && a.mapped + review ? t("reprocess.doneAnchors", { mapped: a.mapped, review }) : t("reprocess.done"));
      },
      [showToast, t],
    ),
  );
  const qc = useQueryClient();
  const { data: highlights, isPending: highlightsPending } = useHighlights(id);
  const { addHighlight, updateHighlight } = useHighlightActions();
  // The library's own order, for the buttons that step to the document before and after this one.
  const { data: shelf } = useDocuments("created_desc");

  const [viewerError, setViewerError] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [mode, setMode] = useState<Mode | null>(null);
  const [findOpen, setFindOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [matchIndex, setMatchIndex] = useState(0);
  const [matchTotal, setMatchTotal] = useState(0);
  const [focus, setFocus] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const [panelTab, setPanelTab] = useState<PanelTab>("info");
  // The column of pages or contents on the left. Like the panel, it starts open only where there is room.
  const [sideOpen, setSideOpen] = useState(false);
  // Places in this layout that the PDF viewer fills: its page field, its zoom, its thumbnails.
  const [pagerSlot, setPagerSlot] = useState<HTMLElement | null>(null);
  const [zoomSlot, setZoomSlot] = useState<HTMLElement | null>(null);
  const [thumbsSlot, setThumbsSlot] = useState<HTMLElement | null>(null);
  // FR-RDR-03: the reading options live behind this gear, so the toolbar stays short.
  const [optsOpen, setOptsOpen] = useState(false);
  const [activeHl, setActiveHl] = useState<string | null>(null);
  const [flashHl, setFlashHl] = useState<string | null>(null);
  // Highlights not placed in the clean text as it is now, and why (AN-104).
  const [hlIssues, setHlIssues] = useState<Record<string, AnchorIssue>>({});
  const [editingHl, setEditingHl] = useState<string | null>(null);
  const [aiQuote, setAiQuote] = useState<string | null>(null);
  const [aiImage, setAiImage] = useState<ChatImage | null>(null);
  const [translating, setTranslating] = useState<{ text: string; rect: DOMRect } | null>(null);
  const closeTranslation = useCallback(() => setTranslating(null), []);
  const [noting, setNoting] = useState<{ sel: TextSelection | PdfSelection; initial: string } | null>(null);
  const closeNote = useCallback(() => setNoting(null), []);
  // The button on a figure in clean text: the chat explains it.
  const explainImage = useCallback((src: string, alt: string) => {
    setAiImage({ src, alt, key: Date.now() });
    setAiQuote(null);
    setPanelOpen(true);
    setPanelTab("chat");
  }, []);
  const [selection, setSelection] = useState<TextSelection | PdfSelection | null>(null);
  // The highlight a ?hl= link points at; it decides the mode the reader opens in.
  const [hlTarget, setHlTarget] = useState<Highlight | null>(null);
  const [fraction, setFraction] = useState(0);
  const [page, setPage] = useState<{ current: number; total: number } | null>(null);
  const compact = useCompact();
  const [barsShown, setBarsShown] = useState(true);
  const [moreOpen, setMoreOpen] = useState(false);

  const readerRef = useRef<CleanReaderHandle>(null);
  const pdfRef = useRef<PdfViewerHandle>(null);
  const modeChosen = useRef(false);
  const pendingJump = useRef<Highlight | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  // What there is to save about the place, sent together once the reader stops moving.
  const pending = useRef<{ fraction?: number; position?: ReadPosition | null; page?: number; total?: number }>({});
  const lastScroll = useRef<ScrollState | null>(null);
  const pageRef = useRef<{ current: number; total: number } | null>(null);
  const markedRead = useRef(false);
  const restored = useRef(false);
  // RD-107: a visit to a passage (a link to a highlight or a search hit, a citation, a highlight from the
  // panel) is not reading on, so it leaves the saved place alone. `back` is where the reader was.
  const [detour, setDetour] = useState<{ back: Resume | null; landed: boolean } | null>(null);
  const detourRef = useRef<Visit | null>(null);
  const settleTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  // The link the reader was opened by (?hl=, ?q=), acted on once.
  const linkVisit = useRef<{ hl: string | null; q: string | null } | null>(null);
  // While the columns come and go around the text (Focus), a scroll does not put the selection menu away.
  const focusHold = useRef(false);
  // Until when an emptied selection is ignored, after a press on the phone's selection bar.
  const menuHold = useRef(0);
  const holdTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  // The phone's bars: where they stand against the scroll, and when a finger or a wheel last moved the text.
  const bars = useRef<BarsState>({ shown: true, anchor: 0 });
  const touchedAt = useRef(-Infinity);

  const isPdf = doc?.file_type === "pdf";
  const hasClean = doc?.extraction_status === "done" && Boolean(doc.content_clean);
  // Non-PDF documents only exist as clean text (FR-RDR-01 step 4).
  const effectiveMode: Mode = !isPdf ? "clean" : mode === "clean" && hasClean ? "clean" : "original";
  const clean = effectiveMode === "clean" && hasClean;
  // Where each block of the clean text is on the PDF, for "view in the original".
  const { data: sourceMap } = useSourceMap(id, Boolean(isPdf && hasClean));
  const { data: charts } = useCharts(id, Boolean(isPdf && hasClean));
  // Clean Reader: the blocks set aside from the text (authors, references, headers…), kept for the reader.
  const { data: aside } = useAside(id, Boolean(isPdf && hasClean));
  const hasSource = useCallback((blockId: string) => sourceMap?.has(blockId) ?? false, [sourceMap]);
  const [sourceRequest, setSourceRequest] = useState<SourceBox[] | null>(null);

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

  // RD-105: the page picked here is kept with the account. Until one is picked the reader follows the theme
  // of the app, and the app's own theme is back when the reader is closed.
  const readingTheme: Theme = savedTheme ?? theme;
  useEffect(() => setPageTheme(readingTheme), [readingTheme, setPageTheme]);
  useEffect(() => () => setPageTheme(null), [setPageTheme]);

  useEffect(() => {
    const wide = window.matchMedia(WIDE).matches;
    setSideOpen(wide && (readFlag(SIDE_KEY) ?? false));
    setPanelOpen((open) => open || (wide && (readFlag(PANEL_KEY) ?? false)));
  }, []);

  // A phone opens these as sheets over the text, for the moment: nothing to remember.
  function toggleSide() {
    if (!compact) writeFlag(SIDE_KEY, !sideOpen);
    setSideOpen(!sideOpen);
  }

  function showPanel(open: boolean) {
    if (!compact) writeFlag(PANEL_KEY, open);
    setPanelOpen(open);
  }

  // The header's Notes and AI buttons: each opens the panel on its tab, and closes it from there.
  const openGroup = panelOpen ? panelGroup(panelTab) : null;
  function togglePanel(group: "notes" | "ai") {
    if (openGroup === group) return showPanel(false);
    setPanelTab(group === "ai" ? "ai" : "highlights");
    showPanel(true);
  }

  useEffect(() => {
    if (modeChosen.current) return;
    const params = new URLSearchParams(window.location.search);
    const hlId = params.get("hl");
    if (hlId && highlightsPending) return; // wait to know where that highlight was made
    modeChosen.current = true;
    linkVisit.current = { hl: hlId, q: params.get("q")?.trim() || null };
    const target = hlId ? (highlights.find((h) => h.id === hlId) ?? null) : null;
    setHlTarget(target);
    const reading = readStoredMode(id) ?? (window.matchMedia("(max-width: 639px)").matches ? "clean" : defaultMode);
    // A link to a highlight opens the view being read when the highlight shows there, else the other one.
    setMode(target ? viewFor(target, reading) : hlId ? "clean" : reading);
    // A summary found by search opens the summary panel (FR-SRCH-01 step 6).
    if (params.get("panel") === "summary") {
      setPanelOpen(true);
      setPanelTab("ai");
    }
    // "Ask AI" on a quick read goes on here, with the article itself to answer from.
    if (params.get("panel") === "chat") {
      setPanelOpen(true);
      setPanelTab("chat");
    }
    // The notebook's links back to a document's notes and mind map.
    if (params.get("panel") === "notes" || params.get("panel") === "mindmap") {
      setPanelOpen(true);
      setPanelTab(params.get("panel") as "notes" | "mindmap");
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
    (issues: Record<string, AnchorIssue>) =>
      setHlIssues((prev) => (JSON.stringify(prev) === JSON.stringify(issues) ? prev : issues)),
    [],
  );

  // FR-HL-01: selections longer than 5,000 characters cannot be highlighted.
  const onSelect = useCallback(
    (s: TextSelection | PdfSelection | null) => {
      if (s && s.text.length > MAX_SELECTION) {
        showToast(MSG["MSG-22"]);
        return setSelection(null);
      }
      if (!s && (focusHold.current || performance.now() < menuHold.current)) return;
      // Selecting only selects (AN-101): a translation is asked for with the menu's Translate button.
      setSelection(s);
    },
    [showToast],
  );

  // A tap on the phone's selection bar may cost the selection before the tap arrives: the bar waits for it.
  const holdSelection = useCallback(() => {
    menuHold.current = performance.now() + MENU_HOLD_MS;
    clearTimeout(holdTimer.current);
    holdTimer.current = setTimeout(() => {
      if (window.getSelection()?.isCollapsed) setSelection(null);
    }, MENU_HOLD_MS + 20);
  }, []);
  useEffect(() => () => clearTimeout(holdTimer.current), []);

  function chooseMode(next: Mode) {
    setMode(next);
    setSelection(null);
    restored.current = false;
    try {
      localStorage.setItem(modeKey(id), next); // FR-RDR-05 step 4: remembered per document on this device
    } catch {
      /* storage unavailable */
    }
  }

  // Keyboard: Ctrl+F opens in-document search; Esc leaves focus mode / closes the reading options.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
        e.preventDefault();
        setFindOpen(true);
      } else if (e.key === "Escape") {
        setOptsOpen(false);
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
  // A passage looked up from a citation or a card (AI-105): when the text shown does not have it, the reader
  // is told so and no empty search is left open.
  const lookup = useRef<string | null>(null);
  const onLookupMissed = useRef<() => void>(() => undefined);
  const onResult = useCallback((n: number, q: string) => {
    setMatchTotal(n);
    if (lookup.current === null || q !== lookup.current) return;
    lookup.current = null;
    if (n === 0) onLookupMissed.current();
  }, []);
  const search = { query: findOpen ? query : "", index: matchIndex, onResult };

  // ---- the place (RD-107, FR-DOC-07). Saved 1.5 s after the reader stops moving and when leaving: the page
  // of the original, the fraction of the clean text and the block under the reading line.
  const savePlace = useCallback(() => {
    clearTimeout(saveTimer.current);
    const { fraction, position, page, total } = pending.current;
    pending.current = {};
    const patch: Parameters<typeof updateDocument>[1] = {};
    if (fraction !== undefined) {
      patch.read_fraction = Math.round(fraction * 10000) / 10000;
      if (position) patch.read_position = position;
    }
    if (page !== undefined) patch.last_read_page = page;
    // Read: on the last page of a PDF, at the end of any other text.
    const finished = isPdf ? page !== undefined && page === total : fraction !== undefined && fraction >= 0.98;
    if (finished && !markedRead.current && !doc?.is_read) {
      markedRead.current = true;
      patch.is_read = true;
    }
    if (!Object.keys(patch).length) return Promise.resolve();
    // This reader, opened again before the document is fetched anew, starts from the place just saved.
    qc.setQueryData<DocumentDetail>([...documentsKey, "detail", id], (old) => (old ? { ...old, ...patch } : old));
    return updateDocument(id, patch).then(
      () => undefined,
      () => undefined,
    );
  }, [id, isPdf, doc?.is_read, qc]);
  const savePlaceRef = useRef(savePlace);
  savePlaceRef.current = savePlace;

  const scheduleSave = useCallback(() => {
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => void savePlaceRef.current(), 1500);
  }, []);

  const endDetour = useCallback(() => {
    detourRef.current = null;
    clearTimeout(settleTimer.current);
    setDetour(null);
  }, []);

  /** The jump has come to rest: this is where the visit landed. */
  const settle = useCallback(
    (visit: Visit) => {
      if (detourRef.current !== visit) return;
      if (!originalRef.current && readerRef.current?.jumping()) {
        // The jump has not got there yet (a slow machine may not even have set off): look again shortly.
        settleTimer.current = setTimeout(() => settle(visit), 400);
        return;
      }
      const scroll = lastScroll.current;
      const onPage = pageRef.current?.current ?? null;
      visit.landTop = scroll?.top ?? 0;
      if (visit.landPage === null) visit.landPage = onPage;
      // A passage that was already on screen, or nearly: the reader has not gone anywhere.
      const stayed =
        visit.from &&
        (visit.from.original
          ? onPage !== null && onPage === visit.from.page
          : Math.abs(visit.landTop - visit.from.top) < (scroll?.view ?? 0));
      if (stayed) endDetour();
      else setDetour((d) => d && (d.landed ? d : { ...d, landed: true }));
    },
    [endDetour],
  );

  const originalRef = useRef(false);
  originalRef.current = effectiveMode === "original";

  /** A visit begins: what was read up to here is saved first, then nothing is until the visit ends. */
  const beginDetour = useCallback(
    (back: Resume | null, opts: { landPage?: number | null; fromHere?: boolean } = {}) => {
      void savePlaceRef.current();
      const visit: Visit = {
        landTop: null,
        landPage: opts.landPage ?? null,
        from: opts.fromHere
          ? { original: originalRef.current, top: lastScroll.current?.top ?? 0, page: pageRef.current?.current ?? null }
          : null,
      };
      const open = detourRef.current !== null;
      detourRef.current = visit;
      // A second visit keeps the first place to go back to. The way back is offered once the jump has landed.
      if (!open) setDetour({ back, landed: false });
      clearTimeout(settleTimer.current);
      settleTimer.current = setTimeout(() => settle(visit), 400);
    },
    [settle],
  );

  /** Where the reader is now, as a place to come back to. */
  const here = useCallback((): Resume | null => {
    const scroll = lastScroll.current;
    return resumeOf({
      fraction: scroll?.fraction ?? doc?.read_fraction,
      position: scroll?.place ? toPosition(scroll.place) : doc?.read_position,
      page: pageRef.current?.current ?? doc?.last_read_page,
    });
  }, [doc?.read_fraction, doc?.read_position, doc?.last_read_page]);

  // The original: the page the reader is on.
  const onPageChange = useCallback(
    (current: number, total: number) => {
      pageRef.current = { current, total };
      setPage({ current, total });
      const visit = detourRef.current;
      if (visit) {
        if (visit.landPage === null) visit.landPage = current;
        if (!readOnPages(visit.landPage, current)) return;
        endDetour(); // well away from the passage: the reader is reading on from here
      }
      pending.current.page = current;
      pending.current.total = total;
      scheduleSave();
    },
    [endDetour, scheduleSave],
  );

  // The clean text: progress, the page it is on and the block under the reading line.
  const onScrollProgress = useCallback(
    (scroll: ScrollState) => {
      lastScroll.current = scroll;
      setFraction(scroll.fraction);
      const total = doc?.page_count;
      const onPage = scroll.page !== null && total ? { current: scroll.page, total } : null;
      if (onPage) {
        pageRef.current = onPage;
        setPage(onPage);
      }
      const visit = detourRef.current;
      if (visit) {
        if (visit.landTop === null) {
          // Still on the way to the passage (the jump scrolls smoothly).
          clearTimeout(settleTimer.current);
          settleTimer.current = setTimeout(() => settle(visit), 400);
          return;
        }
        if (!readOn(visit.landTop, scroll.top, scroll.view)) return;
        endDetour();
      }
      pending.current.fraction = scroll.fraction;
      pending.current.position = scroll.place ? toPosition(scroll.place) : null;
      if (onPage) {
        pending.current.page = onPage.current;
        pending.current.total = onPage.total;
      }
      scheduleSave();
    },
    [doc?.page_count, endDetour, scheduleSave, settle],
  );

  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === "hidden") void savePlaceRef.current();
    };
    document.addEventListener("visibilitychange", onHide);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      clearTimeout(settleTimer.current);
      flushHighlightEdits();
      // The library shows progress and "continue reading" from these values.
      void savePlaceRef.current().finally(() => qc.invalidateQueries({ queryKey: [...documentsKey, "list"] }));
    };
  }, [qc]);

  // A change of type moves the text under the reader, and so does Focus where the columns were squeezing it:
  // the block that was under the reading line goes back there (RD-104, RD-106).
  useEffect(() => {
    const place = lastScroll.current?.place;
    if (!clean || !place) return;
    const frame = requestAnimationFrame(() => readerRef.current?.scrollToPlace(place));
    return () => cancelAnimationFrame(frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus, fontSize, lineHeight, width, fontFamily]);

  // RD-106: going in and out of focus keeps the selection too. Its menu is measured again once the text has
  // settled; on the original the selection stays and the menu comes back with the next selection.
  const toggleFocus = useCallback((next: boolean) => {
    focusHold.current = true;
    setFocus(next);
    if (next) setOptsOpen(false);
    setTimeout(() => {
      focusHold.current = false;
      setSelection((sel) => (sel && "blockId" in sel ? (readerRef.current?.currentSelection() ?? null) : null));
    }, 200);
  }, []);

  // Goes to a highlight only where it is sure to be; false when it cannot be placed (AN-104).
  const jumpTo = useCallback((h: Highlight) => {
    setActiveHl(h.id);
    return Boolean(readerRef.current?.scrollToHighlight(h));
  }, []);

  // A highlight that cannot be placed is not shown somewhere near: its card says so, with its quote (AT-10).
  const unplaced = useCallback(
    (h: Highlight) => {
      endDetour();
      setActiveHl(h.id);
      setPanelOpen(true);
      setPanelTab("highlights");
      showToast(t("reader.hlUnplaced"));
    },
    [endDetour, showToast, t],
  );

  const flash = useCallback((hlId: string) => {
    clearTimeout(flashTimer.current);
    setFlashHl(hlId);
    flashTimer.current = setTimeout(() => setFlashHl(null), 1600);
  }, []);

  // Place the clean text once: on a highlight from the panel or ?hl=, on a search hit (in-document find goes
  // there), otherwise where the reader left off.
  useEffect(() => {
    if (!clean || restored.current || !blocks.length || highlightsPending || !doc) return;
    restored.current = true;
    requestAnimationFrame(() => {
      const link = linkVisit.current;
      linkVisit.current = null;
      const saved = resumeOf({ fraction: doc.read_fraction, position: doc.read_position, page: doc.last_read_page });
      const fromPanel = pendingJump.current;
      const target = fromPanel ?? (link?.hl ? highlights.find((h) => h.id === link.hl) : undefined);
      pendingJump.current = null;
      // A link to a highlight that is not the reader's (or no longer exists) shows nothing of it (AT-20).
      if (link?.hl && !target) showToast(t("reader.hlMissing"));
      if (target) {
        const back = fromPanel ? here() : saved;
        if (!jumpTo(target)) {
          // Not in the clean text, but on the PDF: show it there.
          const [onPdf] = pdfPlaces(target);
          if (onPdf && isPdf) {
            beginDetour(back, { landPage: onPdf.page });
            pendingJump.current = target;
            showToast(t("reader.hlOtherView"));
            return chooseMode("original");
          }
          return unplaced(target);
        }
        beginDetour(back);
        if (!compact) {
          setPanelOpen(true);
          setPanelTab("highlights");
        }
        flash(target.id);
        return;
      }
      if (link?.q) return beginDetour(saved);
      // This sitting's own place comes first (back from the original), then the one kept with the document.
      const scroll = lastScroll.current;
      const fraction = scroll?.fraction ?? doc.read_fraction ?? 0;
      const place =
        scroll?.place ?? (doc.read_position ? { blockId: doc.read_position.block_id, offset: doc.read_position.offset } : null);
      if (fraction <= 0 || fraction >= 0.98) return;
      if (!(place && readerRef.current?.scrollToPlace(place))) readerRef.current?.scrollToFraction(fraction);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clean, blocks.length, highlights, highlightsPending, doc?.id, jumpTo, flash, beginDetour]);

  // Same for the original PDF: go to the linked highlight once the document has loaded.
  useEffect(() => {
    if (effectiveMode !== "original" || restored.current) return;
    const fromPanel = pendingJump.current;
    const target = fromPanel ?? hlTarget;
    if (!target) return;
    restored.current = true;
    pendingJump.current = null;
    if (!fromPanel && linkVisit.current && doc) {
      linkVisit.current = null;
      const saved = resumeOf({ fraction: doc.read_fraction, position: doc.read_position, page: doc.last_read_page });
      beginDetour(saved, { landPage: pdfPlaces(target)[0]?.page ?? target.page });
    }
    if (!compact) {
      setPanelOpen(true);
      setPanelTab("highlights");
    }
    setActiveHl(target.id);
    flash(target.id);
    let tries = 0;
    const timer = setInterval(() => {
      if (pdfRef.current?.scrollToHighlight(target)) return clearInterval(timer);
      if (++tries <= 40) return;
      clearInterval(timer);
      unplaced(target);
    }, 150);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveMode, hlTarget, flash, beginDetour]);

  const viewSource = useCallback(
    (blockId: string) => {
      const boxes = sourceMap?.get(blockId);
      if (!boxes?.length) return showToast(t("reader.noSource"));
      setSourceRequest(boxes);
      chooseMode("original");
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sourceMap, showToast, t],
  );

  // A block set aside from the clean text (Info tab, hidden list, folded references): shown on the PDF.
  const showOnPdf = useCallback(
    (boxes: SourceBox[]) => {
      setSourceRequest(boxes);
      chooseMode("original");
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // The PDF may still be loading after the switch: show the passage as soon as it can be placed.
  useEffect(() => {
    if (effectiveMode !== "original" || !sourceRequest) return;
    let tries = 0;
    const show = () => {
      if (!pdfRef.current?.showSource(sourceRequest) && ++tries <= 40) return false;
      setSourceRequest(null);
      return true;
    };
    if (show()) return;
    const timer = setInterval(() => show() && clearInterval(timer), 150);
    return () => clearInterval(timer);
  }, [effectiveMode, sourceRequest]);

  function openHighlight(h: Highlight) {
    // Looking a highlight up is a visit: the saved place stays where the reader was reading.
    if (effectiveMode === "original") {
      beginDetour(here(), { fromHere: true });
      setActiveHl(h.id);
      if (pdfRef.current?.scrollToHighlight(h)) return flash(h.id);
      // Not placed on the PDF (e.g. made in the clean text of a page it cannot be found on).
      // A highlight made on the PDF that the PDF cannot show, or no clean text to look in: say so.
      if (!hasClean || h.rects) return unplaced(h);
      pendingJump.current = h;
      showToast(t("reader.hlOtherView"));
      return chooseMode("clean");
    }
    const back = here();
    if (jumpTo(h)) {
      beginDetour(back, { fromHere: true });
      return flash(h.id);
    }
    if (pdfPlaces(h).length && isPdf) {
      beginDetour(back, { fromHere: true });
      pendingJump.current = h;
      showToast(t("reader.hlOtherView"));
      return chooseMode("original");
    }
    unplaced(h);
  }

  // Back to where the reader was before the visit, which ends here.
  function goBack() {
    const back = detour?.back;
    endDetour();
    if (!back) return;
    if (effectiveMode === "original") {
      if (back.page) pdfRef.current?.scrollToPage(back.page);
      return;
    }
    const place = back.position && { blockId: back.position.block_id, offset: back.position.offset };
    if (!(place && readerRef.current?.scrollToPlace(place))) readerRef.current?.scrollToFraction(back.fraction);
  }

  // "Read on from here": the visit ends and the place kept is this one, without waiting for the next scroll.
  function readOnHere() {
    endDetour();
    const scroll = lastScroll.current;
    const onPage = pageRef.current;
    if (effectiveMode !== "original" && scroll) {
      pending.current.fraction = scroll.fraction;
      pending.current.position = scroll.place ? toPosition(scroll.place) : null;
    }
    if (onPage) {
      pending.current.page = onPage.current;
      pending.current.total = onPage.total;
    }
    scheduleSave();
  }

  // ---- selection actions
  const clearSelection = useCallback(() => {
    window.getSelection()?.removeAllRanges();
    setSelection(null);
  }, []);

  /** The highlight already on exactly this passage, from whichever view it was made in. */
  function highlightAt(sel: TextSelection | PdfSelection): Highlight | undefined {
    return highlights.find((h) => samePassage(h, sel));
  }

  function highlightSelection(color: HighlightColor): Highlight | null {
    if (!selection) return null;
    const h = markPassage(selection, color);
    clearSelection();
    setActiveHl(h.id);
    return h;
  }

  /** Highlights a passage in `color`, or keeps its note on it: a passage with a highlight keeps its color. */
  function markPassage(sel: TextSelection | PdfSelection, color: HighlightColor, note?: string): Highlight {
    const onPdf = "rects" in sel;
    const existing = highlightAt(sel);
    // AN-105: "highlighted" / "note saved" is said once the server has it, not before.
    const onSaved =
      note !== undefined
        ? () => showToast(t("panel.savedNote"))
        : () => showToast(t("reader.highlighted", { name: colorLabel(colorLabels, color, lang) }));
    // What the server found out about a new highlight: the passage had one, or it could not be carried over.
    const onAdded = (saved: Highlight) => {
      if (saved.duplicate) {
        setActiveHl((current) => (current === h.id ? saved.id : current));
        return showToast(t("reader.hlAlready"));
      }
      const missing = missingView(saved);
      if (missing) return showToast(t(missing === "clean" ? "reader.hlNotSyncedClean" : "reader.hlNotSyncedPdf"));
      if (saved.overlaps?.length) return showToast(t("reader.hlOverlap"));
      onSaved();
    };
    let h: Highlight;
    if (existing && note !== undefined) {
      updateHighlight(existing.id, { note }, { now: true, onSaved });
      h = { ...existing, note };
    } else if (existing?.color === color) {
      showToast(t("reader.hlAlready"));
      h = existing;
    } else if (existing) {
      const category = CATEGORY_FOR_COLOR[color];
      updateHighlight(existing.id, { color, category }, { onSaved });
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
        note: note ?? "",
      }, { onSaved: onAdded });
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
        prefix: sel.prefix,
        suffix: sel.suffix,
        note: note ?? "",
      }, { onSaved: onAdded });
    }
    return h;
  }

  // The note is written in a small card under the passage; the passage is highlighted when it is saved.
  function noteSelection() {
    if (!selection) return;
    setNoting({ sel: selection, initial: highlightAt(selection)?.note ?? "" });
    clearSelection();
  }

  function saveNote(note: string) {
    if (!noting) return;
    const h = markPassage(noting.sel, "yellow", note);
    setActiveHl(h.id);
    setNoting(null);
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
  function translateSelection() {
    if (!selection) return;
    setTranslating({ text: selection.text, rect: selection.rect });
    clearSelection();
  }

  function explainSelection() {
    if (!selection) return;
    setAiQuote(selection.text);
    setPanelOpen(true);
    setPanelTab("chat");
    clearSelection();
  }

  // A summary keyword opens in-document find (FR-SUM-01 output, FR-RDR-04).
  useEffect(() => {
    onLookupMissed.current = () => {
      setFindOpen(false);
      endDetour();
      showToast(t("reader.sourceUnresolved"));
    };
  });

  function findKeyword(keyword: string) {
    beginDetour(here(), { fromHere: true }); // a citation is looked at, not read on from
    if (findOpen && keyword === query) {
      // The same words are already searched for: the count is the one shown.
      if (matchTotal === 0) onLookupMissed.current();
      return;
    }
    lookup.current = keyword;
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
      <div className="flex min-h-dvh items-center justify-center">
        <Spinner label={t("reader.opening")} />
      </div>
    );
  }

  if (isError || !doc || viewerError) {
    return (
      <div className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-4 px-4">
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
      : doc.reading_minutes && timeLeft
        ? t("reader.pctRemaining", {
            pct: Math.round(fraction * 100),
            n: Math.max(1, Math.round(doc.reading_minutes * (1 - fraction))),
          })
        : `${Math.round(fraction * 100)}%`;

  // RD-103: a link out is only ever the address the document was added from.
  const sourceUrl = doc.url && /^https?:\/\//i.test(doc.url) ? doc.url : null;
  const header = (
    <>
      <IntegrityNotice
        issues={doc.extraction_issues}
        onOriginal={isPdf ? () => chooseMode("original") : undefined}
        sourceUrl={isPdf ? null : sourceUrl}
      />
      <div className="font-sans text-[13px] tracking-[0.06em] text-muted">
        {KIND_LABEL[doc.file_type]} · {origin(doc, lang)}
        {doc.reading_minutes ? ` · ${t("common.minutesRead", { n: doc.reading_minutes })}` : ""}
        {!isPdf && ` · ${t("reader.extractedCopy")}`}
        {sourceUrl && (
          <>
            {" · "}
            {/* Underlined, not told apart by its colour alone (WCAG 1.4.1). */}
            <a
              href={sourceUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-accent-text underline decoration-1 underline-offset-2"
            >
              {t("reader.openSource")} ↗
            </a>
          </>
        )}
      </div>
      <h1 className="mb-7 mt-2.5 text-[1.9em] font-medium leading-[1.1] text-ink">{doc.title}</h1>
      <AsideAuthors
        aside={aside}
        onInfo={() => {
          setPanelTab("info");
          showPanel(true);
        }}
      />
    </>
  );

  const original = effectiveMode === "original";
  const progressText = original || hasPages ? [`${Math.round(pct * 100)}%`, pageLabel].filter(Boolean).join(" · ") : pageLabel;
  const resumeWhere = detour?.back
    ? original
      ? detour.back.page
        ? t("reader.resumePage", { n: detour.back.page })
        : null
      : `${Math.round(detour.back.fraction * 100)}%`
    : null;

  const tool =
    "flex h-9 shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-[13px] font-medium text-ink hover:bg-soft disabled:cursor-not-allowed disabled:opacity-40";
  const toolIcon = "icon-btn h-9 w-9 rounded-lg";
  const divider = <span className="mx-1 hidden h-5 w-px shrink-0 bg-line sm:block" />;

  const at = shelf?.findIndex((d) => d.id === id) ?? -1;
  const stepTo = (to: DocumentListItem | undefined, icon: "up" | "down", label: Key) =>
    to ? (
      <Link
        href={`/reader/${to.id}`}
        className="grid h-9 w-9 place-items-center rounded-full text-ink hover:bg-line"
        aria-label={t(label)}
        title={`${t(label)}: ${to.title}`}
      >
        <Icon name={icon} size={18} />
      </Link>
    ) : (
      <span aria-hidden className="grid h-9 w-9 place-items-center text-muted opacity-40">
        <Icon name={icon} size={18} />
      </span>
    );

  const sideLabel = t(original ? "reader.pagesHeading" : "reader.outline");
  const sideBody = original ? (
    <div ref={setThumbsSlot} className="min-h-0 flex-1 overflow-y-auto overscroll-contain" />
  ) : (
    <ReaderOutline
      headings={headings}
      pageOf={hasPages ? (blockId) => blockPage.get(blockId) : undefined}
      onGo={(blockId) => {
        readerRef.current?.scrollToBlock(blockId);
        // Over a narrow page the column covers the text it just scrolled to.
        if (!window.matchMedia("(min-width: 1024px)").matches) setSideOpen(false);
      }}
    />
  );
  const readingOptions = (
    <ReadingOptions clean={clean} showTimeLeft={clean && !hasPages && Boolean(doc.reading_minutes)} readingTheme={readingTheme} />
  );

  // On a phone the panel lies over the text: going to a passage from it has to uncover the text first.
  const thenText = <A,>(go: (a: A) => void) =>
    compact
      ? (a: A) => {
          setPanelOpen(false);
          go(a);
        }
      : go;
  const panel = (
    <ReaderPanel
      embedded={compact}
      docId={id}
      highlights={highlights}
      tab={panelTab}
      onTab={setPanelTab}
      onClose={() => showPanel(false)}
      activeId={activeHl}
      editingId={editingHl}
      onEditing={setEditingHl}
      onJump={thenText(openHighlight)}
      aiQuote={aiQuote}
      onClearQuote={() => setAiQuote(null)}
      aiImage={aiImage}
      onClearImage={() => setAiImage(null)}
      onKeyword={thenText(findKeyword)}
      canHighlight={clean || isPdf}
      issues={clean ? hlIssues : NO_ISSUES}
      progress={progressText}
      onSource={isPdf ? thenText(showOnPdf) : undefined}
    />
  );

  const neighbour = (to: DocumentListItem | undefined, icon: "up" | "down", label: Key): SheetAction[] =>
    to ? [{ key: label, label: t(label), icon, href: `/reader/${to.id}` }] : [];
  const moreActions: SheetAction[] = [
    // After the sheet has given the focus back, or the field would lose it again.
    { key: "find", label: t("find.title"), icon: "search", onSelect: () => requestAnimationFrame(() => setFindOpen(true)) },
    { key: "focus", label: t("reader.focus"), icon: "focus", onSelect: () => toggleFocus(true) },
    ...(isPdf && (original ? hasClean : true)
      ? [
          {
            key: "mode",
            label: t(original ? "reader.switchClean" : "reader.viewOriginal"),
            icon: original ? ("book" as const) : ("file" as const),
            onSelect: () => chooseMode(original ? "clean" : "original"),
          },
        ]
      : []),
    {
      key: "info",
      label: t("reader.tabInfo"),
      icon: "note",
      onSelect: () => {
        setPanelTab("info");
        setPanelOpen(true);
      },
    },
    ...neighbour(at > 0 ? shelf?.[at - 1] : undefined, "up", "reader.prevDoc"),
    ...neighbour(at >= 0 ? shelf?.[at + 1] : undefined, "down", "reader.nextDoc"),
  ];

  const markTouch = () => {
    touchedAt.current = performance.now();
  };
  // The bars answer the reader's own scrolling; a jump to a passage or a restored place leaves them as they are.
  function followReader(e: React.UIEvent<HTMLDivElement>) {
    const el = e.target;
    if (!compact || !(el instanceof HTMLElement) || el.clientHeight < e.currentTarget.clientHeight / 2) return;
    const top = el.scrollTop;
    if (performance.now() - touchedAt.current > TOUCH_SCROLL_MS) {
      bars.current = { ...bars.current, anchor: top };
      return;
    }
    markTouch(); // the text goes on gliding after the finger has lifted
    bars.current = followScroll(bars.current, top, el.scrollHeight - el.clientHeight);
    setBarsShown(bars.current.shown);
  }
  // With the bars away, a tap on the text brings them back.
  function tapReader(e: React.MouseEvent) {
    if (!compact || barsShown) return;
    if ((e.target as Element).closest("a, button, input, select, textarea, dialog")) return;
    if (!window.getSelection()?.isCollapsed) return;
    bars.current = { ...bars.current, shown: true };
    setBarsShown(true);
  }

  return (
    <div className="flex h-dvh bg-bg text-ink">
      <div className="flex min-w-0 flex-1 flex-col pt-[env(safe-area-inset-top)] md:pt-0">
        <div aria-hidden className="h-[3px] shrink-0 bg-line">
          <div className="h-[3px] bg-accent transition-[width] duration-200" style={{ width: `${Math.round(pct * 100)}%` }} />
        </div>

        {!focus && !compact && (
          <header className="flex h-14 shrink-0 items-center gap-1 border-b border-line px-2 sm:px-3">
            <Link href="/library" className={toolIcon} aria-label={t("reader.backToLibrary")} title={t("reader.backToLibrary")}>
              <Icon name="back" size={20} />
            </Link>
            <div className="hidden h-9 shrink-0 items-center rounded-full bg-soft lg:flex">
              {stepTo(at > 0 ? shelf?.[at - 1] : undefined, "up", "reader.prevDoc")}
              {stepTo(at >= 0 ? shelf?.[at + 1] : undefined, "down", "reader.nextDoc")}
            </div>
            <button
              type="button"
              className={`${toolIcon} ${sideOpen ? "bg-soft" : ""}`}
              aria-pressed={sideOpen}
              aria-label={t("reader.toggleSide")}
              title={t("reader.toggleSide")}
              onClick={toggleSide}
            >
              <Icon name="panelLeft" />
            </button>

            {/* What is being read and how far along: the one thing the bar says, the rest are controls. */}
            <div className="mx-2 flex min-w-0 flex-1 flex-col justify-center">
              <span className="hidden truncate text-[14px] font-semibold leading-tight text-ink sm:block" title={doc.title}>
                {doc.title}
              </span>
              <span className="truncate text-[12px] tabular-nums leading-snug text-muted">
                {original ? `${Math.round(pct * 100)}%` : progressText}
              </span>
            </div>

            {isPdf && (
              <div className="hidden h-9 shrink-0 gap-0.5 rounded-[10px] bg-soft p-[3px] md:flex" role="group" aria-label={t("reader.modeAria")}>
                {(["clean", "original"] as const).map((m) => (
                  <button
                    key={m}
                    type="button"
                    aria-pressed={effectiveMode === m}
                    disabled={m === "clean" && !hasClean}
                    title={m === "clean" && !hasClean ? messageFor(doc.extraction_error) : undefined}
                    onClick={() => chooseMode(m)}
                    className={`rounded-[7px] px-3 text-[13px] disabled:cursor-not-allowed disabled:opacity-40 ${
                      effectiveMode === m ? "bg-surface font-semibold text-ink shadow-sm" : "text-muted hover:text-ink"
                    }`}
                  >
                    {t(m === "original" ? "reader.original" : "reader.clean")}
                  </button>
                ))}
              </div>
            )}
            {original && <div ref={setZoomSlot} className="ml-1 hidden shrink-0 lg:block" />}
            {original && <div ref={setPagerSlot} className="ml-1 shrink-0" />}
            {divider}

            <button
              type="button"
              className={toolIcon}
              aria-label={t("reader.findCtrlF")}
              title={t("reader.findCtrlF")}
              onClick={() => setFindOpen((o) => !o)}
              aria-expanded={findOpen}
            >
              <Icon name="search" />
            </button>
            <button
              type="button"
              className={`${toolIcon} font-serif text-[17px] font-semibold ${optsOpen ? "bg-soft" : ""}`}
              aria-expanded={optsOpen}
              aria-label={t("settings.readingOptions")}
              title={t("settings.readingOptions")}
              onClick={() => setOptsOpen((o) => !o)}
            >
              Aa
            </button>
            <button
              type="button"
              className={toolIcon}
              aria-label={t("reader.focus")}
              title={t("reader.focus")}
              data-keep-selection
              // The press must not take the selection away from the text (RD-106).
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => toggleFocus(true)}
            >
              <Icon name="focus" />
            </button>
            {divider}

            <button
              type="button"
              className={`${tool} ${openGroup === "notes" ? "bg-soft" : ""}`}
              aria-pressed={openGroup === "notes"}
              aria-label={t("reader.notesButton", { n: highlights.length })}
              title={t("reader.notesButton", { n: highlights.length })}
              onClick={() => togglePanel("notes")}
            >
              <Icon name="highlighter" />
              <span className="hidden xl:inline">{t("reader.tabNotes")}</span>
              <span className="tabular-nums text-muted">{highlights.length}</span>
            </button>
            <button
              type="button"
              className={`${tool} ${openGroup === "ai" ? "bg-soft" : ""}`}
              aria-pressed={openGroup === "ai"}
              aria-label={t("reader.aiButton")}
              title={t("reader.aiButton")}
              onClick={() => togglePanel("ai")}
            >
              <Icon name="spark" />
              <span>{t("reader.tabAi")}</span>
            </button>
          </header>
        )}

        <div className="flex min-h-0 flex-1">
          {sideOpen && !focus && !compact && (
            <aside
              aria-label={t(original ? "reader.pagesHeading" : "reader.outline")}
              className="fixed inset-y-0 left-0 z-20 flex w-[232px] shrink-0 flex-col border-r border-line bg-surface shadow-pop lg:static lg:z-auto lg:bg-transparent lg:shadow-none"
            >
              <div className="flex h-11 shrink-0 items-center justify-between pl-4 pr-1.5">
                <span className="eyebrow">{t(original ? "reader.pagesHeading" : "reader.outline").toLocaleUpperCase(lang)}</span>
                <button type="button" className="icon-btn h-9 w-9 text-muted lg:hidden" aria-label={t("reader.toggleSide")} onClick={toggleSide}>
                  <Icon name="x" size={16} />
                </button>
              </div>
              {sideBody}
            </aside>
          )}

          <div
            className="relative flex min-w-0 flex-1 flex-col max-md:overflow-hidden"
            onScrollCapture={followReader}
            onTouchMoveCapture={markTouch}
            onTouchEndCapture={markTouch}
            onWheelCapture={markTouch}
            onClick={tapReader}
          >
            {original ? (
              <>
                {doc.extraction_status === "failed" && (
                  <div className="mx-auto w-full max-w-[640px] px-4 pt-4 max-md:pt-16">
                    <Alert>{messageFor(doc.extraction_error)}</Alert>
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
                  bottomInset={compact ? BOTTOM_BAR + 48 : 24}
                  topInset={compact ? TOP_BAR : 0}
                  compact={compact}
                  onThumbPick={() => compact && setSideOpen(false)}
                  highlights={highlights}
                  activeHighlightId={activeHl}
                  flashHighlightId={flashHl}
                  onSelect={onSelect}
                  onHighlightClick={onHighlightClick}
                  pagerSlot={pagerSlot}
                  zoomSlot={zoomSlot}
                  thumbsSlot={thumbsSlot}
                />
              </>
            ) : hasClean ? (
              <>
                <div className="min-h-0 flex-1">
                  <CleanReader
                    handleRef={readerRef}
                    documentId={doc.id}
                    header={header}
                    footer={<ArticleEnd aside={aside} onSource={isPdf ? showOnPdf : undefined} />}
                    blocks={blocks}
                    fontSize={fontSize}
                    lineHeight={lineHeight}
                    width={width}
                    fontFamily={fontFamily}
                    search={search}
                    highlights={highlights}
                    activeHighlightId={activeHl}
                    flashHighlightId={flashHl}
                    onSelect={onSelect}
                    onHighlightClick={onHighlightClick}
                    onUnanchored={onUnanchored}
                    onScrollProgress={onScrollProgress}
                    onExplainImage={explainImage}
                    onViewSource={isPdf ? viewSource : undefined}
                    hasSource={hasSource}
                    charts={charts}
                    bottomPadding={compact ? BOTTOM_BAR + 64 : 80}
                    topInset={compact ? TOP_BAR : 0}
                    compact={compact}
                  />
                </div>
              </>
            ) : doc.extraction_status === "failed" ? (
              <div className="mx-auto flex max-w-md flex-1 flex-col justify-center gap-4 px-4">
                <Alert>{messageFor(doc.extraction_error)}</Alert>
                <p className="text-sm leading-relaxed text-muted">{t("reader.noContentHint")}</p>
                <div className="flex flex-wrap gap-2">
                  {sourceUrl && (
                    <a href={sourceUrl} target="_blank" rel="noopener noreferrer" className="btn-primary">
                      {t("reader.openSource")} ↗
                    </a>
                  )}
                  <Link href="/library" className="btn-outline">
                    {t("reader.backToLibrary")}
                  </Link>
                </div>
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

            {optsOpen && !focus && !compact && (
              <div
                role="dialog"
                aria-label={t("settings.readingOptions")}
                className="absolute right-3 top-3 z-20 w-[min(340px,calc(100%-24px))] rounded-[14px] border border-line bg-surface p-4 shadow-float"
              >
                {readingOptions}
              </div>
            )}

            {detour?.landed && resumeWhere && <ResumeChip where={resumeWhere} onBack={goBack} onDismiss={readOnHere} />}

            {compact && !focus && (
              <PhoneReaderBars
                topShown={barsShown && !findOpen}
                bottomShown={barsShown}
                title={doc.title}
                progress={progressText}
                pagerRef={original ? setPagerSlot : undefined}
                sideIcon={original ? "file" : "toc"}
                sideLabel={sideLabel}
                notes={highlights.length}
                onSide={() => setSideOpen(true)}
                onNotes={() => togglePanel("notes")}
                onAi={() => togglePanel("ai")}
                onOptions={() => setOptsOpen(true)}
                onMore={() => setMoreOpen(true)}
              />
            )}

            {focus && (
              <button
                type="button"
                data-keep-selection
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => toggleFocus(false)}
                className="absolute right-4 top-4 z-10 flex h-11 items-center gap-2 rounded-full border border-line bg-surface px-4 text-sm text-muted opacity-60 transition-opacity hover:opacity-100 focus-visible:opacity-100"
              >
                <Icon name="x" size={16} />
                {t("reader.exitFocus")}
              </button>
            )}
          </div>
        </div>
      </div>

      {panelOpen && !focus && !compact && panel}

      {compact && (
        <>
          <BottomSheet open={panelOpen && !focus} onClose={() => setPanelOpen(false)} label={t("panel.aria")} tall flush>
            {panel}
          </BottomSheet>
          <BottomSheet open={sideOpen && !focus} onClose={() => setSideOpen(false)} label={sideLabel} tall flush>
            <span className="eyebrow shrink-0 px-4 pb-2">{sideLabel.toLocaleUpperCase(lang)}</span>
            {sideBody}
          </BottomSheet>
          <BottomSheet open={optsOpen && !focus} onClose={() => setOptsOpen(false)} label={t("settings.readingOptions")}>
            <div className="px-1 pt-1">{readingOptions}</div>
          </BottomSheet>
          <ActionSheet open={moreOpen} onClose={() => setMoreOpen(false)} label={t("reader.more")} actions={moreActions}>
            {original && <div ref={setZoomSlot} className="mb-1 flex justify-center border-b border-line pb-2" />}
          </ActionSheet>
        </>
      )}

      {selection && (clean || "rects" in selection) && (
        <SelectionMenu
          selection={selection}
          docked={compact}
          onPress={compact ? holdSelection : undefined}
          onColor={(c) => highlightSelection(c)}
          onNote={noteSelection}
          onCopy={copySelection}
          onExplain={SELECTION_EXPLAIN ? explainSelection : undefined}
          onTranslate={SELECTION_TRANSLATE ? translateSelection : undefined}
          onSource={
            "blockId" in selection && hasSource(selection.blockId)
              ? () => {
                  viewSource(selection.blockId);
                  clearSelection();
                }
              : undefined
          }
          onDismiss={() => setSelection(null)}
        />
      )}
      {translating && (
        <TranslatePopover
          key={translating.text}
          docId={id}
          text={translating.text}
          rect={translating.rect}
          onClose={closeTranslation}
        />
      )}
      {noting && (
        <NotePopover
          key={noting.sel.text}
          text={noting.sel.text}
          rect={noting.sel.rect}
          initial={noting.initial}
          onSave={saveNote}
          onClose={closeNote}
        />
      )}
    </div>
  );
}

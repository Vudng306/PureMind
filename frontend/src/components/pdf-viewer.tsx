"use client";

import type { PDFDocumentLoadingTask, PDFDocumentProxy, RenderTask } from "pdfjs-dist";
import { useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import "pdfjs-dist/web/pdf_viewer.css";

import { pdfPlaces, type Highlight } from "@/lib/annotations";
import { API_URL, authHeader } from "@/lib/api";
import type { SourceBox } from "@/lib/documents";
import { clearHighlights, findMatches, findRanges, paintHighlights, scrollRangeIntoView } from "@/lib/find";
import { useT } from "@/lib/i18n";
import { useSelectionTracking } from "@/lib/mobile";
import { hitRects, rangeRects, rectsArea, type PdfRect } from "@/lib/pdf-rects";
import type { HighlightColor } from "@/lib/preferences";

import type { SearchState } from "./clean-reader";
import { Icon } from "./icons";

export type ZoomMode = "fit-width" | "fit-page" | number;

const MIN_ZOOM = 0.5;
const MAX_ZOOM = 3;
const STEP = 0.1;
const GAP = 16;
const PAD = 16;
const PHONE_SIDE = 4; // a phone gives the width to the page
const FIT_SNAP = 0.06; // a pinch ending this near the page's fitting width settles on it
const RENDER_RADIUS = 2; // FR-RDR-01 step 3: only pages within ±2 of the visible one are rendered
const ZOOM_LEVELS = Array.from({ length: 26 }, (_, i) => Math.round((0.5 + i * 0.1) * 10) / 10);
const THUMB_WIDTH = 108;
const THUMB_MARGIN = 600; // thumbnails this far outside the column are drawn ahead of being scrolled to

const clampZoom = (z: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(z * 10) / 10));

type Size = { w: number; h: number };

/** A passage selected on the original page (FR-HL-01 step 2). */
export interface PdfSelection {
  page: number;
  rects: PdfRect[];
  text: string;
  rect: DOMRect;
}

export interface PdfViewerHandle {
  /** Scroll to a highlight's page and line; false if its position on the PDF is unknown. */
  scrollToHighlight: (h: Highlight) => boolean;
  /** Scroll to a passage of the clean text on the PDF and outline it for a moment; false before the PDF loads. */
  showSource: (boxes: SourceBox[]) => boolean;
  /** Scroll to the top of a page; false before the PDF loads. */
  scrollToPage: (page: number) => boolean;
}

const SOURCE_SHOWN_MS = 2600;

/** A highlight drawn on one page. */
interface Mark {
  id: string;
  color: HighlightColor;
  rects: PdfRect[];
  active: boolean;
  flash: boolean;
}

async function loadPdfjs() {
  const pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc ||= new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();
  return pdfjs;
}

function PageView({
  pdf,
  pageNumber,
  scale,
  size,
  onSize,
  onTextLayer,
  marks,
  source,
}: {
  pdf: PDFDocumentProxy;
  pageNumber: number;
  scale: number;
  size: Size;
  onSize: (page: number, size: Size) => void;
  onTextLayer: (page: number, el: HTMLElement | null) => void;
  marks: Mark[] | undefined;
  source: PdfRect[] | undefined;
}) {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let cancelled = false;
    let task: RenderTask | null = null;

    (async () => {
      const pdfjs = await loadPdfjs();
      const page = await pdf.getPage(pageNumber);
      if (cancelled) return;
      const base = page.getViewport({ scale: 1 });
      if (Math.abs(base.width - size.w) > 0.5 || Math.abs(base.height - size.h) > 0.5) {
        onSize(pageNumber, { w: base.width, h: base.height });
      }
      const viewport = page.getViewport({ scale });
      const ratio = window.devicePixelRatio || 1;
      const canvas = document.createElement("canvas");
      canvas.width = Math.floor(viewport.width * ratio);
      canvas.height = Math.floor(viewport.height * ratio);
      canvas.style.width = `${Math.floor(viewport.width)}px`;
      canvas.style.height = `${Math.floor(viewport.height)}px`;
      task = page.render({ canvas, viewport, transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : undefined });
      try {
        await task.promise;
      } catch {
        return; // cancelled
      }
      if (cancelled) return;
      const textLayer = document.createElement("div");
      textLayer.className = "textLayer";
      host.replaceChildren(canvas, textLayer);
      host.style.setProperty("--scale-factor", String(scale));
      host.style.setProperty("--total-scale-factor", String(scale));
      await new pdfjs.TextLayer({ textContentSource: page.streamTextContent(), container: textLayer, viewport }).render();
      if (!cancelled) onTextLayer(pageNumber, textLayer);
    })().catch(() => undefined);

    return () => {
      cancelled = true;
      task?.cancel();
      onTextLayer(pageNumber, null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pdf, pageNumber, scale]);

  const width = Math.floor(size.w * scale);
  const height = Math.floor(size.h * scale);
  return (
    <div className="relative" style={{ width, height }}>
      <div ref={hostRef} data-page={pageNumber} className="pdf-page" style={{ width, height }} />
      {/* Highlights sit above the page image; clicks and selection pass through to the text layer. */}
      <div aria-hidden className="pdf-marks pointer-events-none absolute inset-0 z-[3]">
        {marks?.flatMap((m) =>
          m.rects.map((r, i) => (
            <span
              key={`${m.id}-${i}`}
              className={`pdf-mark hl-bg-${m.color}${m.active ? " pdf-mark-active" : ""}${m.flash ? " pdf-mark-flash" : ""}`}
              style={{ left: `${r.x * 100}%`, top: `${r.y * 100}%`, width: `${r.w * 100}%`, height: `${r.h * 100}%` }}
            />
          )),
        )}
      </div>
      {source && (
        <div aria-hidden className="pointer-events-none absolute inset-0 z-[4]">
          {source.map((r, i) => (
            <span
              key={i}
              className="pdf-source"
              style={{ left: `${r.x * 100}%`, top: `${r.y * 100}%`, width: `${r.w * 100}%`, height: `${r.h * 100}%` }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/** One page, small. It is drawn only while it is near the visible part of the column, so a long PDF stays light. */
function Thumb({
  pdf,
  page,
  size,
  active,
  near,
  onPick,
}: {
  pdf: PDFDocumentProxy;
  page: number;
  size: Size;
  active: boolean;
  near: boolean;
  onPick: (page: number) => void;
}) {
  const t = useT();
  const hostRef = useRef<HTMLSpanElement>(null);
  // Until the page itself has been opened, its shape is taken to be the first page's.
  const [shape, setShape] = useState<Size | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !near) return;
    let cancelled = false;
    let task: RenderTask | null = null;
    (async () => {
      const pdfPage = await pdf.getPage(page);
      if (cancelled) return;
      const base = pdfPage.getViewport({ scale: 1 });
      setShape({ w: base.width, h: base.height });
      const ratio = Math.min(2, window.devicePixelRatio || 1);
      const viewport = pdfPage.getViewport({ scale: (THUMB_WIDTH / base.width) * ratio });
      const canvas = document.createElement("canvas");
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      canvas.className = "block h-full w-full";
      task = pdfPage.render({ canvas, viewport });
      try {
        await task.promise;
      } catch {
        return; // cancelled
      }
      if (!cancelled) host.replaceChildren(canvas);
    })().catch(() => undefined);
    return () => {
      cancelled = true;
      task?.cancel();
      host.replaceChildren();
    };
  }, [pdf, page, near]);

  const { w, h } = shape ?? size;
  return (
    <button
      type="button"
      data-thumb={page}
      onClick={() => onPick(page)}
      aria-label={t("reader.goToPage", { n: page })}
      aria-current={active ? "page" : undefined}
      className={`relative shrink-0 rounded-lg border-2 bg-white p-0.5 transition-colors ${
        active ? "border-accent shadow-card" : "border-transparent shadow-sm hover:border-field"
      }`}
      style={{ width: THUMB_WIDTH + 8, height: Math.round((h / w) * THUMB_WIDTH) + 8 }}
    >
      <span ref={hostRef} className="block h-full w-full overflow-hidden rounded-[5px]" />
      <span
        className={`absolute bottom-1.5 left-1/2 grid h-5 min-w-5 -translate-x-1/2 place-items-center rounded-full px-1.5 text-[11px] font-semibold tabular-nums ${
          active ? "bg-accent text-white" : "bg-black/55 text-white"
        }`}
      >
        {page}
      </span>
    </button>
  );
}

/** Every page as a small picture, in a column beside the document; the page being read is marked and kept in view. */
function Thumbnails({
  pdf,
  sizes,
  current,
  onPick,
}: {
  pdf: PDFDocumentProxy;
  sizes: Size[];
  current: number;
  onPick: (page: number) => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState<Set<number>>(() => new Set([current]));

  useEffect(() => {
    const list = listRef.current;
    const scroller = list?.parentElement;
    if (!list || !scroller) return;
    const io = new IntersectionObserver(
      (entries) =>
        setNear((prev) => {
          const next = new Set(prev);
          for (const e of entries) {
            const page = Number((e.target as HTMLElement).dataset.thumb);
            if (e.isIntersecting) next.add(page);
            else next.delete(page);
          }
          return next;
        }),
      { root: scroller, rootMargin: `${THUMB_MARGIN}px 0px` },
    );
    list.querySelectorAll("[data-thumb]").forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [pdf, sizes.length]);

  // Scrolled by hand rather than with scrollIntoView, which would also move the page around the column.
  useEffect(() => {
    const list = listRef.current;
    const scroller = list?.parentElement;
    const el = list?.querySelector<HTMLElement>(`[data-thumb="${current}"]`);
    if (!scroller || !el) return;
    const top = el.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
    const pad = 20;
    if (top - pad < scroller.scrollTop) scroller.scrollTop = top - pad;
    else if (top + el.offsetHeight + pad > scroller.scrollTop + scroller.clientHeight) {
      scroller.scrollTop = top + el.offsetHeight + pad - scroller.clientHeight;
    }
  }, [current]);

  return (
    <div
      ref={listRef}
      className="flex flex-col items-center gap-5 px-3 py-5 max-md:flex-row max-md:flex-wrap max-md:items-start max-md:justify-center max-md:gap-3 max-md:pb-[calc(20px+env(safe-area-inset-bottom))] max-md:pt-1"
    >
      {sizes.map((size, i) => (
        <Thumb key={i} pdf={pdf} page={i + 1} size={size} active={current === i + 1} near={near.has(i + 1)} onPick={onPick} />
      ))}
    </div>
  );
}

interface Props {
  documentId: string;
  initialPage: number;
  onPageChange: (page: number, total: number) => void;
  onError: () => void;
  reloadKey: number;
  search: SearchState;
  /** Extra scroll space below the last page (room for the floating reader toolbar). */
  bottomInset?: number;
  /** How much of the top of the viewer a bar lying over it covers. */
  topInset?: number;
  /** A phone: selection follows the system's handles, and pages can be pinched. */
  compact?: boolean;
  /** A page was chosen among the thumbnails. */
  onThumbPick?: () => void;
  handleRef?: React.Ref<PdfViewerHandle>;
  highlights: Highlight[];
  activeHighlightId: string | null;
  flashHighlightId: string | null;
  onSelect: (selection: PdfSelection | null) => void;
  onHighlightClick: (id: string) => void;
  /**
   * Places in the reader's own layout for the viewer's controls. When a slot is given (even null, while its
   * element is not there yet) the control is drawn in it instead of in the viewer's own bar.
   */
  pagerSlot?: HTMLElement | null;
  zoomSlot?: HTMLElement | null;
  /** Where the column of page thumbnails goes; without it there are none. */
  thumbsSlot?: HTMLElement | null;
}

/** FR-RDR-01..04, FR-HL-01/02: continuous PDF.js viewer with virtualized pages, navigation, zoom, find and highlights. */
export function PdfViewer({
  documentId,
  initialPage,
  onPageChange,
  onError,
  reloadKey,
  search,
  bottomInset = 0,
  topInset = 0,
  compact = false,
  onThumbPick,
  handleRef,
  highlights,
  activeHighlightId,
  flashHighlightId,
  onSelect,
  onHighlightClick,
  pagerSlot,
  zoomSlot,
  thumbsSlot,
}: Props) {
  const t = useT();
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [sizes, setSizes] = useState<Size[]>([]);
  const [viewport, setViewport] = useState<Size>({ w: 0, h: 0 });
  const [zoom, setZoom] = useState<ZoomMode>("fit-width");
  const [current, setCurrent] = useState(initialPage);
  const [pageInput, setPageInput] = useState(String(initialPage));
  // Reading position used to restore the view after zoom/resize: top-most page and how far into it.
  const anchor = useRef({ page: initialPage, fraction: 0 });
  // Where a pinch left the pages sideways, applied once they are laid out at their new size.
  const pinchLeft = useRef<number | null>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const total = pdf?.numPages ?? 0;
  const headroom = PAD + topInset;
  const side = compact ? PHONE_SIDE : PAD;

  // ---- load
  useEffect(() => {
    let cancelled = false;
    let task: PDFDocumentLoadingTask | null = null;
    (async () => {
      try {
        const pdfjs = await loadPdfjs();
        task = pdfjs.getDocument({
          url: `${API_URL}/api/documents/${documentId}/file`,
          httpHeaders: await authHeader(),
          disableAutoFetch: true,
          rangeChunkSize: 1 << 20,
        });
        const doc = await task.promise;
        const first = (await doc.getPage(1)).getViewport({ scale: 1 });
        if (cancelled) return;
        const start = Math.min(Math.max(1, anchor.current.page), doc.numPages);
        anchor.current = { page: start, fraction: 0 };
        // Every page starts with page 1's size; real sizes are filled in as pages render.
        setSizes(Array.from({ length: doc.numPages }, () => ({ w: first.width, h: first.height })));
        setCurrent(start);
        setPdf(doc);
      } catch {
        if (!cancelled) onError();
      }
    })();
    return () => {
      cancelled = true;
      task?.destroy();
      setPdf(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [documentId, reloadKey]);

  // ---- container size
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setViewport((v) => (Math.abs(v.w - width) > 1 || Math.abs(v.h - height) > 1 ? { w: width, h: height } : v));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // ---- layout
  const scale = useMemo(() => {
    const ref = sizes[anchor.current.page - 1] ?? sizes[0];
    if (!ref || !viewport.w) return 1;
    const availW = Math.max(200, viewport.w - 2 * side);
    const availH = Math.max(200, viewport.h - headroom - PAD);
    if (zoom === "fit-width") return Math.min(MAX_ZOOM, availW / ref.w);
    if (zoom === "fit-page") return Math.min(availW / ref.w, availH / ref.h);
    return zoom;
  }, [zoom, viewport, sizes, side, headroom]);

  const heights = useMemo(() => sizes.map((s) => Math.floor(s.h * scale)), [sizes, scale]);
  const tops = useMemo(() => {
    const out: number[] = [];
    let y = headroom;
    for (const h of heights) {
      out.push(y);
      y += h + GAP;
    }
    out.push(y);
    return out;
  }, [heights, headroom]);

  const pageAt = useCallback(
    (y: number) => {
      let lo = 0;
      let hi = heights.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (tops[mid] <= y) lo = mid;
        else hi = mid - 1;
      }
      return lo + 1;
    },
    [tops, heights.length],
  );

  // Keep the reading position when scale or page sizes change.
  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (!el || !pdf || !heights.length) return;
    const { page, fraction } = anchor.current;
    el.scrollTop = Math.max(0, tops[page - 1] - headroom + fraction * (heights[page - 1] + GAP));
    if (pinchLeft.current !== null) {
      el.scrollLeft = pinchLeft.current;
      pinchLeft.current = null;
    }
  }, [pdf, tops, heights, headroom]);

  const onScroll = useCallback(() => {
    const el = scrollerRef.current;
    if (!el || !heights.length) return;
    const top = pageAt(el.scrollTop + headroom);
    anchor.current = {
      page: top,
      fraction: Math.min(1, Math.max(0, (el.scrollTop + headroom - tops[top - 1]) / (heights[top - 1] + GAP))),
    };
    const visible = pageAt(el.scrollTop + el.clientHeight * 0.35);
    setCurrent((c) => (c === visible ? c : visible));
    // On a phone the selection bar is not over the text, and the passage may be scrolled clear of it.
    if (!compact) onSelect(null);
  }, [pageAt, heights, tops, onSelect, headroom, compact]);

  useEffect(() => {
    setPageInput(String(current));
    if (total) onPageChange(current, total);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current, total]);

  const goTo = useCallback(
    (n: number) => {
      const el = scrollerRef.current;
      if (!el || !total) return;
      const page = Math.min(Math.max(1, n), total);
      anchor.current = { page, fraction: 0 };
      el.scrollTop = tops[page - 1] - headroom;
      setCurrent(page);
    },
    [tops, total, headroom],
  );

  const zoomBy = useCallback((delta: number) => setZoom(clampZoom(scale + delta)), [scale]);

  const onSize = useCallback((page: number, size: Size) => {
    setSizes((prev) => {
      const next = prev.slice();
      next[page - 1] = size;
      return next;
    });
  }, []);

  // ---- keyboard (FR-RDR-02) & ctrl+wheel zoom (FR-RDR-03)
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.target as HTMLElement).closest("input, textarea, select, [contenteditable=true]")) return;
      if (e.key === "ArrowRight" || e.key === "PageDown") goTo(current + 1);
      else if (e.key === "ArrowLeft" || e.key === "PageUp") goTo(current - 1);
      else if ((e.ctrlKey || e.metaKey) && (e.key === "=" || e.key === "+")) zoomBy(STEP);
      else if ((e.ctrlKey || e.metaKey) && e.key === "-") zoomBy(-STEP);
      else return;
      e.preventDefault();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [goTo, zoomBy, current]);

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    function onWheel(e: WheelEvent) {
      if (!e.ctrlKey) return;
      e.preventDefault();
      zoomBy(e.deltaY < 0 ? STEP : -STEP);
    }
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoomBy]);

  // ---- pinch (phones): the pages are stretched under the fingers and drawn anew at their size when they lift,
  // with the point between the fingers staying where it is.
  const fitRef = sizes[anchor.current.page - 1] ?? sizes[0];
  const layout = useRef({ scale, tops, heights, pageAt, headroom, fit: 0 });
  layout.current = { scale, tops, heights, pageAt, headroom, fit: fitRef ? (viewport.w - 2 * side) / fitRef.w : 0 };

  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller || !compact) return;
    const el = scroller;
    let start: { dist: number; x: number; y: number; ox: number; oy: number } | null = null;
    let now = { x: 0, y: 0, ratio: 1 };

    function measure(e: TouchEvent) {
      const [a, b] = [e.touches[0], e.touches[1]];
      const box = el.getBoundingClientRect();
      return {
        dist: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY),
        x: (a.clientX + b.clientX) / 2 - box.left,
        y: (a.clientY + b.clientY) / 2 - box.top,
      };
    }
    function onStart(e: TouchEvent) {
      if (e.touches.length !== 2) return;
      const m = measure(e);
      start = { ...m, ox: el.scrollLeft + m.x, oy: el.scrollTop + m.y };
      now = { x: m.x, y: m.y, ratio: 1 };
    }
    function onMove(e: TouchEvent) {
      const content = contentRef.current;
      if (!start || !content || e.touches.length < 2) return;
      e.preventDefault();
      const m = measure(e);
      const { scale } = layout.current;
      const ratio = Math.min(MAX_ZOOM / scale, Math.max(MIN_ZOOM / scale, m.dist / start.dist));
      now = { x: m.x, y: m.y, ratio };
      content.style.transformOrigin = `${start.ox}px ${start.oy}px`;
      content.style.transform = `translate(${m.x - start.x}px, ${m.y - start.y}px) scale(${ratio})`;
    }
    function onEnd(e: TouchEvent) {
      if (!start || e.touches.length >= 2) return;
      const { ox, oy } = start;
      start = null;
      const content = contentRef.current;
      if (content) {
        content.style.transform = "";
        content.style.transformOrigin = "";
      }
      const { scale, tops, heights, pageAt, headroom, fit } = layout.current;
      const wanted = scale * now.ratio;
      const snapped = Math.abs(wanted - fit) < FIT_SNAP;
      const next = snapped ? fit : clampZoom(wanted);
      if (Math.abs(next - scale) < 0.001) return;
      // What is now at the reading line stays there once the pages have their new size.
      const y = oy + (headroom - now.y) / now.ratio;
      const page = pageAt(y);
      anchor.current = { page, fraction: Math.min(1, Math.max(0, (y - tops[page - 1]) / (heights[page - 1] + GAP))) };
      pinchLeft.current = Math.max(0, ox * (next / scale) - now.x);
      setZoom(snapped ? "fit-width" : next);
    }

    el.addEventListener("touchstart", onStart, { passive: true });
    el.addEventListener("touchmove", onMove, { passive: false });
    el.addEventListener("touchend", onEnd);
    el.addEventListener("touchcancel", onEnd);
    return () => {
      el.removeEventListener("touchstart", onStart);
      el.removeEventListener("touchmove", onMove);
      el.removeEventListener("touchend", onEnd);
      el.removeEventListener("touchcancel", onEnd);
    };
  }, [compact]);

  // ---- find (FR-RDR-04)
  const { query, index, onResult } = search;
  const [pageMatchCounts, setPageMatchCounts] = useState<number[] | null>(null);
  const pageTexts = useRef<Map<number, string>>(new Map());
  const textLayers = useRef<Map<number, HTMLElement>>(new Map());
  const [layersVersion, setLayersVersion] = useState(0);
  const lastScrolledMatch = useRef("");

  const onTextLayer = useCallback((page: number, el: HTMLElement | null) => {
    if (el) textLayers.current.set(page, el);
    else textLayers.current.delete(page);
    setLayersVersion((v) => v + 1);
  }, []);

  useEffect(() => {
    pageTexts.current.clear();
  }, [pdf]);

  // Count matches on every page from the PDF text content (same text the text layer renders).
  useEffect(() => {
    if (!pdf || !query.trim()) {
      setPageMatchCounts(null);
      onResult(0, query);
      return;
    }
    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        const counts: number[] = [];
        for (let p = 1; p <= pdf.numPages; p++) {
          let text = pageTexts.current.get(p);
          if (text === undefined) {
            const content = await (await pdf.getPage(p)).getTextContent();
            text = content.items.map((it) => ("str" in it ? it.str : "")).join("");
            pageTexts.current.set(p, text);
          }
          if (cancelled) return;
          counts.push(findMatches(text, query).length);
        }
        setPageMatchCounts(counts);
        onResult(
          counts.reduce((a, b) => a + b, 0),
          query,
        );
      } catch {
        /* document closed while searching */
      }
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [pdf, query, onResult]);

  const activeMatch = useMemo(() => {
    if (!pageMatchCounts) return null;
    const totalMatches = pageMatchCounts.reduce((a, b) => a + b, 0);
    if (!totalMatches) return null;
    let i = ((index % totalMatches) + totalMatches) % totalMatches;
    for (let p = 0; p < pageMatchCounts.length; p++) {
      if (i < pageMatchCounts[p]) return { page: p + 1, local: i, key: `${query}|${index}` };
      i -= pageMatchCounts[p];
    }
    return null;
  }, [pageMatchCounts, index, query]);

  // Bring the active match's page into view so its text layer gets rendered.
  useEffect(() => {
    const el = scrollerRef.current;
    if (!activeMatch || !el) return;
    const top = tops[activeMatch.page - 1];
    const bottom = tops[activeMatch.page];
    if (bottom < el.scrollTop || top > el.scrollTop + el.clientHeight) goTo(activeMatch.page);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeMatch]);

  useEffect(() => {
    if (!query.trim() || !pageMatchCounts) {
      clearHighlights();
      return;
    }
    const all: Range[] = [];
    let currentRange: Range | null = null;
    for (const [page, layer] of textLayers.current) {
      const ranges = findRanges(layer, query);
      all.push(...ranges);
      if (activeMatch && page === activeMatch.page && ranges.length) {
        currentRange = ranges[Math.min(activeMatch.local, ranges.length - 1)];
      }
    }
    paintHighlights(all, currentRange);
    if (currentRange && activeMatch && scrollerRef.current && lastScrolledMatch.current !== activeMatch.key) {
      lastScrolledMatch.current = activeMatch.key;
      scrollRangeIntoView(scrollerRef.current, currentRange);
    }
  }, [query, pageMatchCounts, activeMatch, layersVersion]);

  useEffect(() => clearHighlights, []);

  // ---- highlights (FR-HL-02)
  // Each shows where the server placed it, over as many lines and pages as it runs. One it could not place
  // here is not looked for by its words: the same words may stand somewhere else on the page.
  const marksByPage = useMemo(() => {
    const out = new Map<number, Mark[]>();
    for (const h of highlights) {
      for (const { page, rects } of pdfPlaces(h)) {
        const list = out.get(page) ?? [];
        list.push({ id: h.id, color: h.color, rects, active: h.id === activeHighlightId, flash: h.id === flashHighlightId });
        out.set(page, list);
      }
    }
    return out;
  }, [highlights, activeHighlightId, flashHighlightId]);

  // The passage "view in the original" points at, outlined until it fades.
  const [source, setSource] = useState<Map<number, PdfRect[]> | null>(null);
  const sourceTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(sourceTimer.current), []);

  const scrollToPoint = useCallback(
    (page: number, y: number): boolean => {
      const el = scrollerRef.current;
      if (!el || !page || !total || page > total) return false;
      const top = Math.max(0, tops[page - 1] + y * heights[page - 1] - el.clientHeight / 3);
      // Remember the position so it survives page sizes changing while nearby pages render.
      const first = pageAt(top + headroom);
      const fraction = (top + headroom - tops[first - 1]) / (heights[first - 1] + GAP);
      anchor.current = { page: first, fraction: Math.min(1, Math.max(0, fraction)) };
      el.scrollTop = top;
      setCurrent(page);
      return true;
    },
    [pageAt, tops, heights, total, headroom],
  );

  useImperativeHandle(
    handleRef,
    () => ({
      scrollToHighlight(h) {
        const [first] = pdfPlaces(h);
        return first ? scrollToPoint(first.page, first.rects[0]?.y ?? 0) : false;
      },
      showSource(boxes) {
        if (!boxes.length || !scrollToPoint(boxes[0].page, boxes[0].y)) return false;
        const byPage = new Map<number, PdfRect[]>();
        for (const { page, ...rect } of boxes) byPage.set(page, [...(byPage.get(page) ?? []), rect]);
        setSource(byPage);
        clearTimeout(sourceTimer.current);
        sourceTimer.current = setTimeout(() => setSource(null), SOURCE_SHOWN_MS);
        return true;
      },
      scrollToPage: (page) => scrollToPoint(page, 0),
    }),
    [scrollToPoint],
  );

  // Selecting text on a page opens the highlight menu; a click on a highlight opens it in the panel.
  const readSelection = useCallback((): PdfSelection | null => {
    const sel = window.getSelection();
    const scroller = scrollerRef.current;
    if (!sel || !scroller || sel.rangeCount === 0 || sel.isCollapsed) return null;
    const range = sel.getRangeAt(0).cloneRange();
    if (!scroller.contains(range.commonAncestorContainer)) return null;
    const start = range.startContainer;
    const layer = (start instanceof Element ? start : start.parentElement)?.closest<HTMLElement>(".textLayer");
    const host = layer?.parentElement;
    const page = Number(host?.dataset.page);
    if (!layer || !host || !page) return null;
    let text = sel.toString();
    // A selection running onto later pages is clamped to the page it starts on.
    if (!layer.contains(range.endContainer)) {
      range.setEnd(layer, layer.childNodes.length);
      text = range.toString();
    }
    text = text.replace(/\s+/g, " ").trim();
    const rects = text ? rangeRects(range, host) : [];
    if (!rects.length) return null;
    return { page, rects, text, rect: range.getBoundingClientRect() };
  }, []);
  useSelectionTracking(compact, readSelection, onSelect);

  const onPointerUp = useCallback(
    (e: React.MouseEvent | React.TouchEvent) => {
      const target = e.target as Element;
      const point = "clientX" in e ? { x: e.clientX, y: e.clientY } : null;
      requestAnimationFrame(() => {
        const selection = readSelection();
        onSelect(selection);
        if (selection || !point) return;
        const host = target.closest<HTMLElement>(".pdf-page[data-page]");
        if (!host) return;
        const box = host.getBoundingClientRect();
        const px = (point.x - box.left) / box.width;
        const py = (point.y - box.top) / box.height;
        // Of highlights that overlap, the smallest: the larger one can be clicked outside it.
        const [hit] = (marksByPage.get(Number(host.dataset.page)) ?? [])
          .filter((m) => hitRects(m.rects, px, py))
          .sort((a, b) => rectsArea(a.rects) - rectsArea(b.rects));
        if (hit) onHighlightClick(hit.id);
      });
    },
    [readSelection, onSelect, onHighlightClick, marksByPage],
  );

  const onKeyUp = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.shiftKey || e.key === "Shift") onSelect(readSelection());
    },
    [readSelection, onSelect],
  );

  // ---- render
  const first = Math.max(1, current - RENDER_RADIUS);
  const last = Math.min(total, current + RENDER_RADIUS);
  const zoomValue = typeof zoom === "number" ? String(zoom) : zoom;

  const inSlots = pagerSlot !== undefined || zoomSlot !== undefined;
  const step = inSlots ? "icon-btn hidden h-9 w-9 sm:inline-flex" : "icon-btn h-10 w-10";
  // On a phone pages are reached by scrolling or by their number; the zoom has a sheet with room for real buttons.
  const pageStep = compact ? "hidden" : step;
  const zoomStep = compact ? "icon-btn h-11 w-11" : step;

  const pager = (
    <div className="flex items-center gap-1 text-sm">
      <button type="button" className={pageStep} onClick={() => goTo(current - 1)} disabled={current <= 1} aria-label={t("pdf.previousPage")}>
        <Icon name="back" />
      </button>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const n = parseInt(pageInput, 10);
          if (Number.isNaN(n)) setPageInput(String(current));
          else goTo(n);
          if (compact) e.currentTarget.querySelector("input")?.blur();
        }}
        className="flex items-center gap-1.5"
      >
        <label className="sr-only" htmlFor="page-input">
          {t("pdf.pageNumber")}
        </label>
        <input
          id="page-input"
          className={
            compact
              ? "input h-9 w-14 px-1 text-center tabular-nums"
              : inSlots
                ? "input h-8 w-12 px-1 text-center text-[13px] tabular-nums"
                : "input h-9 w-14 px-2 text-center text-sm"
          }
          inputMode="numeric"
          enterKeyHint="go"
          value={pageInput}
          onChange={(e) => setPageInput(e.target.value.replace(/\D/g, ""))}
          onFocus={(e) => compact && e.target.select()}
          onBlur={() => {
            // A phone's number pad may have no Enter: leaving the field goes to the page typed.
            const n = parseInt(pageInput, 10);
            const page = compact && n && total ? Math.min(Math.max(1, n), total) : current;
            if (page !== current) goTo(page);
            setPageInput(String(page));
          }}
        />
        <span className="whitespace-nowrap tabular-nums text-muted" aria-live="polite">
          / {total || "…"}
        </span>
      </form>
      <button type="button" className={pageStep} onClick={() => goTo(current + 1)} disabled={!total || current >= total} aria-label={t("pdf.nextPage")}>
        <Icon name="next" />
      </button>
    </div>
  );

  const zoomer = (
    <div className="flex items-center gap-1 text-sm">
      <button type="button" className={zoomStep} onClick={() => zoomBy(-STEP)} disabled={scale <= MIN_ZOOM} aria-label={t("pdf.zoomOut")}>
        <Icon name="minus" />
      </button>
      <select
        className={
          compact
            ? "input h-11 w-auto py-0 pl-3 pr-8"
            : inSlots
              ? "input h-8 w-auto py-0 pl-2 pr-7 text-[13px]"
              : "input h-9 w-auto px-2 text-sm"
        }
        aria-label={t("pdf.zoomLevel")}
        value={zoomValue}
        onChange={(e) => {
          const v = e.target.value;
          setZoom(v === "fit-width" || v === "fit-page" ? v : Number(v));
        }}
      >
        <option value="fit-width">{t("pdf.fitWidth")}</option>
        <option value="fit-page">{t("pdf.fitPage")}</option>
        {typeof zoom === "number" && !ZOOM_LEVELS.includes(zoom) && <option value={zoomValue}>{Math.round(zoom * 100)}%</option>}
        {ZOOM_LEVELS.map((z) => (
          <option key={z} value={String(z)}>
            {Math.round(z * 100)}%
          </option>
        ))}
      </select>
      <button type="button" className={zoomStep} onClick={() => zoomBy(STEP)} disabled={scale >= MAX_ZOOM} aria-label={t("pdf.zoomIn")}>
        <Icon name="plus" />
      </button>
    </div>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {inSlots ? (
        <>
          {pagerSlot && createPortal(pager, pagerSlot)}
          {zoomSlot && createPortal(zoomer, zoomSlot)}
        </>
      ) : (
        <div className="flex flex-wrap items-center justify-center gap-1.5 border-b border-line px-3 py-1.5">
          {pager}
          <span className="mx-2 hidden h-5 w-px bg-line sm:block" />
          {zoomer}
        </div>
      )}
      {pdf &&
        thumbsSlot &&
        createPortal(
          <Thumbnails
            pdf={pdf}
            sizes={sizes}
            current={current}
            onPick={(page) => {
              goTo(page);
              onThumbPick?.();
            }}
          />,
          thumbsSlot,
        )}

      {/* Focusable, so the pages scroll with the arrow keys and Page Up/Down as well (WCAG 2.1.1). */}
      <div
        ref={scrollerRef}
        role="region"
        aria-label={t("reader.original")}
        tabIndex={0}
        onScroll={onScroll}
        onMouseUp={onPointerUp}
        onTouchEnd={onPointerUp}
        onKeyUp={onKeyUp}
        className={`relative min-h-0 flex-1 overflow-auto bg-bg ${compact ? "touch-pan-x touch-pan-y" : ""}`}
      >
        {!pdf ? (
          <div className="p-6 text-sm text-muted" role="status">
            {t("pdf.loading")}
          </div>
        ) : (
          <div ref={contentRef} className="relative" style={{ height: tops[tops.length - 1] + bottomInset }}>
            {sizes.map((size, i) => {
              const page = i + 1;
              const width = Math.floor(size.w * scale);
              return (
                <div
                  key={page}
                  className="absolute flex justify-center"
                  style={{ top: tops[i], left: 0, minWidth: "100%", width: width + 2 * side }}
                >
                  {page >= first && page <= last ? (
                    <PageView
                      pdf={pdf}
                      pageNumber={page}
                      scale={scale}
                      size={size}
                      onSize={onSize}
                      onTextLayer={onTextLayer}
                      marks={marksByPage.get(page)}
                      source={source?.get(page)}
                    />
                  ) : (
                    <div className="pdf-page" style={{ width, height: heights[i] }} />
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

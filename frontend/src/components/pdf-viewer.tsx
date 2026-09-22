"use client";

import type { PDFDocumentLoadingTask, PDFDocumentProxy, RenderTask } from "pdfjs-dist";
import { useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from "react";

import "pdfjs-dist/web/pdf_viewer.css";

import type { Highlight } from "@/lib/annotations";
import { API_URL, authHeader } from "@/lib/api";
import { clearHighlights, findLoose, findMatches, findRanges, paintHighlights, scrollRangeIntoView } from "@/lib/find";
import { useT } from "@/lib/i18n";
import { hitRects, rangeRects, type PdfRect } from "@/lib/pdf-rects";
import type { HighlightColor } from "@/lib/preferences";

import type { SearchState } from "./clean-reader";
import { Icon } from "./icons";

export type ZoomMode = "fit-width" | "fit-page" | number;

const MIN_ZOOM = 0.5;
const MAX_ZOOM = 3;
const STEP = 0.1;
const GAP = 16;
const PAD = 16;
const RENDER_RADIUS = 2; // FR-RDR-01 step 3: only pages within ±2 of the visible one are rendered
const ZOOM_LEVELS = Array.from({ length: 26 }, (_, i) => Math.round((0.5 + i * 0.1) * 10) / 10);

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
}

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
}: {
  pdf: PDFDocumentProxy;
  pageNumber: number;
  scale: number;
  size: Size;
  onSize: (page: number, size: Size) => void;
  onTextLayer: (page: number, el: HTMLElement | null) => void;
  marks: Mark[] | undefined;
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
  handleRef?: React.Ref<PdfViewerHandle>;
  highlights: Highlight[];
  activeHighlightId: string | null;
  flashHighlightId: string | null;
  onSelect: (selection: PdfSelection | null) => void;
  onHighlightClick: (id: string) => void;
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
  handleRef,
  highlights,
  activeHighlightId,
  flashHighlightId,
  onSelect,
  onHighlightClick,
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
  const total = pdf?.numPages ?? 0;

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
    const availW = Math.max(200, viewport.w - 2 * PAD);
    const availH = Math.max(200, viewport.h - 2 * PAD);
    if (zoom === "fit-width") return Math.min(MAX_ZOOM, availW / ref.w);
    if (zoom === "fit-page") return Math.min(availW / ref.w, availH / ref.h);
    return zoom;
  }, [zoom, viewport, sizes]);

  const heights = useMemo(() => sizes.map((s) => Math.floor(s.h * scale)), [sizes, scale]);
  const tops = useMemo(() => {
    const out: number[] = [];
    let y = PAD;
    for (const h of heights) {
      out.push(y);
      y += h + GAP;
    }
    out.push(y);
    return out;
  }, [heights]);

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
    el.scrollTop = Math.max(0, tops[page - 1] - PAD + fraction * (heights[page - 1] + GAP));
  }, [pdf, tops, heights]);

  const onScroll = useCallback(() => {
    const el = scrollerRef.current;
    if (!el || !heights.length) return;
    const top = pageAt(el.scrollTop + PAD);
    anchor.current = {
      page: top,
      fraction: Math.min(1, Math.max(0, (el.scrollTop + PAD - tops[top - 1]) / (heights[top - 1] + GAP))),
    };
    const visible = pageAt(el.scrollTop + el.clientHeight * 0.35);
    setCurrent((c) => (c === visible ? c : visible));
    onSelect(null);
  }, [pageAt, heights, tops, onSelect]);

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
      el.scrollTop = tops[page - 1] - PAD;
      setCurrent(page);
    },
    [tops, total],
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
      onResult(0);
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
        onResult(counts.reduce((a, b) => a + b, 0));
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
  // Highlights made in the clean text have no rectangles: their passage is looked up in the page's text
  // layer once it is rendered. Positions are kept (normalised) after the page is unloaded.
  const located = useRef(new Map<string, { page: number; rects: PdfRect[] }>());
  const [locatedVersion, setLocatedVersion] = useState(0);

  useEffect(() => {
    located.current.clear();
  }, [pdf]);

  useEffect(() => {
    let changed = false;
    for (const h of highlights) {
      if (h.rects) continue;
      const pages = h.page ? [h.page] : [...textLayers.current.keys()];
      for (const page of pages) {
        const layer = textLayers.current.get(page);
        const host = layer?.parentElement;
        if (!layer || !host) continue;
        const known = located.current.get(h.id);
        if (known && known.page === page) break;
        const [range] = findRanges(layer, h.text, findLoose);
        const rects = range ? rangeRects(range, host) : [];
        if (rects.length) {
          located.current.set(h.id, { page, rects });
          changed = true;
          break;
        }
      }
    }
    if (changed) setLocatedVersion((v) => v + 1);
  }, [highlights, layersVersion]);

  const positionOf = useCallback(
    (h: Highlight): { page: number; rects: PdfRect[] } | null =>
      h.rects && h.page ? { page: h.page, rects: h.rects } : (located.current.get(h.id) ?? null),
    [],
  );

  const marksByPage = useMemo(() => {
    const out = new Map<number, Mark[]>();
    for (const h of highlights) {
      const pos = positionOf(h);
      if (!pos) continue;
      const list = out.get(pos.page) ?? [];
      list.push({
        id: h.id,
        color: h.color,
        rects: pos.rects,
        active: h.id === activeHighlightId,
        flash: h.id === flashHighlightId,
      });
      out.set(pos.page, list);
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [highlights, activeHighlightId, flashHighlightId, locatedVersion, positionOf]);

  useImperativeHandle(
    handleRef,
    () => ({
      scrollToHighlight(h) {
        const el = scrollerRef.current;
        const pos = positionOf(h);
        const page = pos?.page ?? h.page;
        if (!el || !page || !total || page > total) return false;
        const y = pos?.rects[0]?.y ?? 0;
        const top = Math.max(0, tops[page - 1] + y * heights[page - 1] - el.clientHeight / 3);
        // Remember the position so it survives page sizes changing while nearby pages render.
        const first = pageAt(top + PAD);
        const fraction = (top + PAD - tops[first - 1]) / (heights[first - 1] + GAP);
        anchor.current = { page: first, fraction: Math.min(1, Math.max(0, fraction)) };
        el.scrollTop = top;
        setCurrent(page);
        return true;
      },
    }),
    [positionOf, pageAt, tops, heights, total],
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
        const hit = [...(marksByPage.get(Number(host.dataset.page)) ?? [])].reverse().find((m) => hitRects(m.rects, px, py));
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

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center justify-center gap-1.5 border-b border-line px-3 py-1.5 text-sm">
        <button type="button" className="icon-btn h-10 w-10" onClick={() => goTo(current - 1)} disabled={current <= 1} aria-label={t("pdf.previousPage")}>
          <Icon name="back" />
        </button>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const n = parseInt(pageInput, 10);
            if (Number.isNaN(n)) setPageInput(String(current));
            else goTo(n);
          }}
          className="flex items-center gap-1"
        >
          <label className="sr-only" htmlFor="page-input">
            {t("pdf.pageNumber")}
          </label>
          <input
            id="page-input"
            className="input h-9 w-14 px-2 text-center text-sm"
            inputMode="numeric"
            value={pageInput}
            onChange={(e) => setPageInput(e.target.value.replace(/\D/g, ""))}
            onBlur={() => setPageInput(String(current))}
          />
          <span className="text-muted" aria-live="polite">
            / {total || "…"}
          </span>
        </form>
        <button type="button" className="icon-btn h-10 w-10" onClick={() => goTo(current + 1)} disabled={!total || current >= total} aria-label={t("pdf.nextPage")}>
          <Icon name="next" />
        </button>

        <span className="mx-2 hidden h-5 w-px bg-line sm:block" />

        <button type="button" className="icon-btn h-10 w-10" onClick={() => zoomBy(-STEP)} disabled={scale <= MIN_ZOOM} aria-label={t("pdf.zoomOut")}>
          <Icon name="minus" />
        </button>
        <select
          className="input h-9 w-auto px-2 text-sm"
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
        <button type="button" className="icon-btn h-10 w-10" onClick={() => zoomBy(STEP)} disabled={scale >= MAX_ZOOM} aria-label={t("pdf.zoomIn")}>
          <Icon name="plus" />
        </button>
      </div>

      <div
        ref={scrollerRef}
        onScroll={onScroll}
        onMouseUp={onPointerUp}
        onTouchEnd={onPointerUp}
        onKeyUp={onKeyUp}
        className="relative min-h-0 flex-1 overflow-auto bg-bg"
      >
        {!pdf ? (
          <div className="p-6 text-sm text-muted" role="status">
            {t("pdf.loading")}
          </div>
        ) : (
          <div className="relative" style={{ height: tops[tops.length - 1] + bottomInset }}>
            {sizes.map((size, i) => {
              const page = i + 1;
              const width = Math.floor(size.w * scale);
              return (
                <div
                  key={page}
                  className="absolute flex justify-center"
                  style={{ top: tops[i], left: 0, minWidth: "100%", width: width + 2 * PAD }}
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

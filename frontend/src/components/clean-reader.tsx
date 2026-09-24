"use client";

import {
  Fragment,
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";

import { apiFetch } from "@/lib/api";
import {
  blockOf,
  caretAt,
  clearAnnotations,
  offsetIn,
  paintAnnotations,
  rangeAt,
  rangeFor,
  resolveAnchor,
  type Anchor,
  type Highlight,
} from "@/lib/annotations";
import { clearHighlights, findRanges, paintHighlights, scrollRangeIntoView } from "@/lib/find";
import { useLang, useT } from "@/lib/i18n";
import { ChartData } from "@/components/chart-data";
import { MathBlock } from "@/components/math-block";
import type { Chart } from "@/lib/documents";
import { DOC_IMAGE, type Block, type Inline } from "@/lib/markdown";

import { Icon } from "./icons";

export interface SearchState {
  query: string;
  index: number;
  onResult: (total: number) => void;
}

/** A passage the reader just selected, in block offsets. */
export interface TextSelection {
  blockId: string;
  start: number;
  end: number;
  text: string;
  rect: DOMRect;
}

export interface CleanReaderHandle {
  scrollToBlock: (blockId: string) => void;
  scrollToHighlight: (h: Highlight) => boolean;
  scrollToFraction: (fraction: number) => void;
}

const cellText = (nodes: Inline[]): string =>
  nodes.map((n) => ("v" in n ? n.v : "c" in n ? cellText(n.c) : "\n")).join("");

/** A short one-line cell ("Case 1", "2.886") is kept on one line rather than wrapped in a narrow column. */
function isLabel(cell: Inline[]): boolean {
  const text = cellText(cell).trim();
  return text.length <= 16 && !text.includes("\n");
}

function Inlines({ nodes }: { nodes: Inline[] }) {
  return (
    <>
      {nodes.map((n, i) => {
        switch (n.t) {
          case "text":
            return <Fragment key={i}>{n.v}</Fragment>;
          case "strong":
            return (
              <strong key={i} className="font-semibold text-ink">
                <Inlines nodes={n.c} />
              </strong>
            );
          case "em":
            return (
              <em key={i}>
                <Inlines nodes={n.c} />
              </em>
            );
          case "code":
            return (
              <code key={i} className="rounded bg-soft px-1 py-0.5 font-mono text-[0.85em]">
                {n.v}
              </code>
            );
          case "br":
            return <br key={i} />;
          case "link":
            return (
              <a key={i} href={n.href} target="_blank" rel="noopener noreferrer nofollow" className="text-accent underline underline-offset-2">
                <Inlines nodes={n.c} />
              </a>
            );
        }
      })}
    </>
  );
}

/** The document being read, so its own images can be fetched from the API. */
interface ReaderImages {
  documentId: string;
  /** Ask the chat to explain a figure; no button is shown without it. */
  onExplain?: (src: string, alt: string) => void;
  /** Show a block on the original PDF; no button is shown for a block it cannot place. */
  onViewSource?: (blockId: string) => void;
  hasSource?: (blockId: string) => boolean;
  /** The data of the document's vector charts, by image name. */
  charts?: Record<string, Chart>;
}

const ImagesContext = createContext<ReaderImages>({ documentId: "" });

/**
 * An image extracted from the document. It needs the reader's token, which an <img> cannot send, so it is
 * fetched when it scrolls near and shown from a blob URL. A failed one is left out, like a broken web image.
 */
function DocImage({
  documentId,
  name,
  alt,
  className,
}: {
  documentId: string;
  name: string;
  alt: string;
  className: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el || !documentId) return;
    let url: string | null = null;
    let cancelled = false;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        observer.disconnect();
        apiFetch(`/documents/${documentId}/images/${name}`)
          .then((res) => res.blob())
          .then((blob) => {
            if (cancelled) return;
            url = URL.createObjectURL(blob);
            setSrc(url);
          })
          .catch(() => !cancelled && setFailed(true));
      },
      { rootMargin: "800px 0px" },
    );
    observer.observe(el);
    return () => {
      cancelled = true;
      observer.disconnect();
      if (url) URL.revokeObjectURL(url);
    };
  }, [documentId, name]);

  if (failed) return null;
  return src ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={src} alt={alt} className={className} />
  ) : (
    <div ref={ref} className={`${className} min-h-24 min-w-24 animate-pulse bg-soft`} aria-hidden />
  );
}

/** A figure of the document: extracted from the file (`pm-image:`) or linked from the web article. */
export function FigureImage({
  documentId,
  src,
  alt,
  className = "mx-auto max-h-[70vh] w-auto max-w-full rounded-lg",
}: {
  documentId: string;
  src: string;
  alt: string;
  className?: string;
}) {
  const own = DOC_IMAGE.exec(src);
  if (own) return <DocImage documentId={documentId} name={own[1]} alt={alt} className={className} />;
  return (
    // Articles link images on any host; next/image would need every one of them in an allowlist.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt={alt}
      loading="lazy"
      // The source site learns nothing about who is reading, and referer-based hotlink blocks do not trigger.
      referrerPolicy="no-referrer"
      className={className}
      onError={(e) => {
        // A removed or blocked image would otherwise leave a broken icon in the middle of the text.
        e.currentTarget.closest("figure")?.setAttribute("hidden", "");
      }}
    />
  );
}

const HOVER_CHIP =
  "chip h-8 bg-surface/95 px-2.5 font-sans text-[12px] shadow-sm transition-opacity group-hover:opacity-100 focus-visible:opacity-100 sm:opacity-0 [@media(hover:none)]:opacity-100";

/** "View in the original" on a figure or table: the extraction may have misread it, the PDF has it right. */
function SourceButton({ blockId }: { blockId: string }) {
  const t = useT();
  const { onViewSource, hasSource } = useContext(ImagesContext);
  if (!onViewSource || !hasSource?.(blockId)) return null;
  return (
    <button type="button" onClick={() => onViewSource(blockId)} className={HOVER_CHIP}>
      <Icon name="file" size={13} className="text-accent" />
      {t("reader.viewInPdf")}
    </button>
  );
}

function Figure({ blockId, src, alt }: { blockId: string; src: string; alt: string }) {
  const t = useT();
  const { documentId, onExplain, charts } = useContext(ImagesContext);
  const chart = charts?.[DOC_IMAGE.exec(src)?.[1] ?? ""];
  const [showData, setShowData] = useState(false);
  return (
    <>
      <div className="group relative">
        <FigureImage documentId={documentId} src={src} alt={alt} />
        <div className="absolute right-2 top-2 flex flex-wrap justify-end gap-1.5">
          <SourceButton blockId={blockId} />
          {chart && (
            <button
              type="button"
              aria-expanded={showData}
              onClick={() => setShowData((v) => !v)}
              className={`${HOVER_CHIP} ${showData ? "!opacity-100" : ""}`}
            >
              <Icon name="chart" size={13} className="text-accent" />
              {t("reader.chartData")}
            </button>
          )}
          {onExplain && (
            <button type="button" onClick={() => onExplain(src, alt)} className={HOVER_CHIP}>
              <Icon name="spark" size={13} className="text-accent" />
              {t("chat.explainImage")}
            </button>
          )}
        </div>
      </div>
      {chart && showData && <ChartData chart={chart} />}
    </>
  );
}

const BlockView = memo(function BlockView({ block }: { block: Block }) {
  const common = { "data-block-id": block.id };
  switch (block.t) {
    case "heading": {
      const cls = {
        1: "mb-3 mt-9 text-[1.35em] font-semibold",
        2: "mb-3 mt-8 text-[1.2em] font-semibold",
        3: "mb-2 mt-6 text-[1.08em] font-semibold",
      }[block.level];
      const Tag = `h${block.level + 1}` as "h2" | "h3" | "h4"; // h1 is the document title
      return (
        <Tag {...common} className={`scroll-mt-6 leading-[1.25] text-ink ${cls}`}>
          <Inlines nodes={block.c} />
        </Tag>
      );
    }
    case "paragraph":
      return (
        // Căn đều hai bên như sách in; ngắt từ để hai lề thẳng mà không để lại khoảng trắng loang lổ.
        <p {...common} className="mb-[18px] hyphens-auto text-justify">
          <Inlines nodes={block.c} />
        </p>
      );
    case "quote":
      return (
        <blockquote {...common} className="mb-[18px] border-l-[3px] border-line pl-4 italic text-muted">
          <Inlines nodes={block.c} />
        </blockquote>
      );
    case "code":
      return (
        <pre {...common} className="mb-[18px] overflow-x-auto rounded-lg bg-soft p-3 font-mono text-[0.8em] leading-relaxed">
          <code>{block.v}</code>
        </pre>
      );
    case "list": {
      const ListTag = block.ordered ? "ol" : "ul";
      return (
        <ListTag {...common} className={`mb-[18px] space-y-1 pl-6 ${block.ordered ? "list-decimal" : "list-disc"}`}>
          {block.items.map((item, i) => (
            <li key={i} style={{ marginLeft: `${item.depth * 1.25}em` }}>
              <Inlines nodes={item.c} />
            </li>
          ))}
        </ListTag>
      );
    }
    case "table":
      return (
        <div {...common} className="group relative mb-[18px]">
          <div className="absolute right-1 top-1 z-[1] flex">
            <SourceButton blockId={block.id} />
          </div>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse font-sans text-[0.8em]">
              <tbody>
                {block.rows.map((row, r) => (
                  <tr key={r} className={r === 0 && block.head ? "bg-soft font-medium" : ""}>
                    {row.map((cell, c) => (
                      <td
                        key={c}
                        className={`border border-line px-2 py-1 align-top ${isLabel(cell) ? "whitespace-nowrap" : ""}`}
                      >
                        <Inlines nodes={cell} />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      );
    case "image":
      return (
        <figure {...common} className="mb-[18px] select-none">
          <Figure blockId={block.id} src={block.src} alt={block.alt} />
          {block.alt && (
            <figcaption className="mt-1.5 text-center font-sans text-[0.72em] leading-normal text-muted">
              {block.alt}
            </figcaption>
          )}
        </figure>
      );
    case "math":
      return (
        // Not selectable: the typeset glyphs are not the equation's text, so a highlight could not hold.
        <div {...common} className="group relative mb-[18px] select-none">
          <div className="absolute right-1 top-1 z-[1] flex">
            <SourceButton blockId={block.id} />
          </div>
          <MathBlock tex={block.tex} className="py-1 text-ink" />
        </div>
      );
    case "pagebreak":
      return (
        // Only a marker for the page indicator: the text reads on across pages, as in a book.
        <div data-page-break={block.page} aria-hidden="true" />
      );
  }
});

/** Trim whitespace at both ends of a [start, end) slice of `text`. */
function trimSpan(text: string, start: number, end: number): [number, number] {
  while (start < end && /\s/.test(text[start])) start++;
  while (end > start && /\s/.test(text[end - 1])) end--;
  return [start, end];
}

/** FR-RDR-05: clean text mode — Source Serif 4, adjustable size, line height and column width; highlights. */
export function CleanReader({
  handleRef,
  documentId,
  header,
  blocks,
  fontSize,
  lineHeight,
  width,
  search,
  highlights,
  activeHighlightId,
  flashHighlightId = null,
  onSelect,
  onHighlightClick,
  onUnanchored,
  onScrollProgress,
  onExplainImage,
  onViewSource,
  hasSource,
  charts,
  bottomPadding,
}: {
  handleRef: React.Ref<CleanReaderHandle>;
  documentId: string;
  header: React.ReactNode;
  blocks: Block[];
  fontSize: number;
  lineHeight: number;
  width: number;
  search: SearchState;
  highlights: Highlight[];
  activeHighlightId: string | null;
  flashHighlightId?: string | null;
  onSelect: (selection: TextSelection | null) => void;
  onHighlightClick: (id: string) => void;
  /** Highlights whose passage could not be found in the current text (FR-HL-02). */
  onUnanchored?: (ids: string[]) => void;
  onScrollProgress: (fraction: number, page: number | null) => void;
  /** Ask the AI to explain a figure (the button on each image). */
  onExplainImage?: (src: string, alt: string) => void;
  /** Show a block on the original PDF (the button on figures and tables). */
  onViewSource?: (blockId: string) => void;
  hasSource?: (blockId: string) => boolean;
  /** The data of the vector charts (the "Chart data" button on those figures). */
  charts?: Record<string, Chart>;
  bottomPadding: number;
}) {
  const t = useT();
  const lang = useLang();
  const images = useMemo(
    () => ({ documentId, onExplain: onExplainImage, onViewSource, hasSource, charts }),
    [documentId, onExplainImage, onViewSource, hasSource, charts],
  );
  const scrollerRef = useRef<HTMLDivElement>(null);
  const articleRef = useRef<HTMLElement>(null);
  const { query, index, onResult } = search;

  // ---- find
  useEffect(() => {
    const article = articleRef.current;
    if (!article || !query.trim()) {
      clearHighlights();
      onResult(0);
      return;
    }
    const ranges = findRanges(article, query);
    onResult(ranges.length);
    const current = ranges.length ? ranges[((index % ranges.length) + ranges.length) % ranges.length] : null;
    paintHighlights(ranges, current);
    if (current && scrollerRef.current) scrollRangeIntoView(scrollerRef.current, current);
  }, [query, index, blocks, onResult]);

  useEffect(() => clearHighlights, []);

  // ---- highlights (placed where their passage is now; see resolveAnchor)
  const anchors = useRef(new Map<string, Anchor>());
  useEffect(() => {
    const article = articleRef.current;
    if (!article) return;
    let active: Range | null = null;
    let flash: Range | null = null;
    const painted: { color: Highlight["color"]; range: Range }[] = [];
    const lost: string[] = [];
    anchors.current = new Map();
    for (const h of highlights) {
      const anchor = resolveAnchor(article, h);
      const range = anchor && rangeAt(article, anchor);
      if (!anchor || !range) {
        lost.push(h.id);
        continue;
      }
      anchors.current.set(h.id, anchor);
      painted.push({ color: h.color, range });
      if (h.id === activeHighlightId) active = range;
      if (h.id === flashHighlightId) flash = range;
    }
    paintAnnotations(painted, active, flash);
    onUnanchored?.(lost);
  }, [highlights, activeHighlightId, flashHighlightId, blocks, onUnanchored]);

  useEffect(() => clearAnnotations, []);

  useImperativeHandle(
    handleRef,
    () => ({
      scrollToBlock(blockId) {
        const el = articleRef.current?.querySelector<HTMLElement>(`[data-block-id="${CSS.escape(blockId)}"]`);
        const scroller = scrollerRef.current;
        if (!el || !scroller) return;
        const top = el.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop - 24;
        scroller.scrollTo({ top, behavior: "smooth" });
      },
      scrollToHighlight(h) {
        const article = articleRef.current;
        const scroller = scrollerRef.current;
        const anchor = article && resolveAnchor(article, h);
        const range = article && anchor && rangeAt(article, anchor);
        if (!range || !scroller) return false;
        const rect = range.getBoundingClientRect();
        const box = scroller.getBoundingClientRect();
        scroller.scrollTo({ top: scroller.scrollTop + rect.top - box.top - box.height / 3, behavior: "smooth" });
        return true;
      },
      scrollToFraction(fraction) {
        const scroller = scrollerRef.current;
        if (scroller) scroller.scrollTop = fraction * (scroller.scrollHeight - scroller.clientHeight);
      },
    }),
    [],
  );

  // ---- selection → highlight menu; click on a highlight → open it in the panel
  const readSelection = useCallback(() => {
    const article = articleRef.current;
    const sel = window.getSelection();
    if (!article || !sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
    const range = sel.getRangeAt(0);
    if (!article.contains(range.commonAncestorContainer)) return null;
    const block = blockOf(range.startContainer);
    if (!block?.dataset.blockId) return null;
    const blockText = block.textContent ?? "";
    let start = offsetIn(block, range.startContainer, range.startOffset);
    // A selection running into later blocks is clamped to the first one.
    let end = block.contains(range.endContainer) ? offsetIn(block, range.endContainer, range.endOffset) : blockText.length;
    [start, end] = trimSpan(blockText, start, end);
    if (end <= start) return null;
    const text = blockText.slice(start, end);
    const exact = rangeFor(article, { blockId: block.dataset.blockId, start, end, text });
    return {
      blockId: block.dataset.blockId,
      start,
      end,
      text,
      rect: (exact ?? range).getBoundingClientRect(),
    } satisfies TextSelection;
  }, []);

  const onPointerUp = useCallback(
    (e: React.MouseEvent | React.TouchEvent) => {
      // Let the browser finish updating the selection first.
      requestAnimationFrame(() => {
        const selection = readSelection();
        if (selection) return onSelect(selection);
        onSelect(null);
        if (!("clientX" in e)) return;
        const caret = caretAt(e.clientX, e.clientY);
        const block = caret && blockOf(caret.node);
        if (!caret || !block?.dataset.blockId) return;
        const offset = offsetIn(block, caret.node, caret.offset);
        const blockId = block.dataset.blockId;
        const hit = [...anchors.current].find(([, a]) => a.blockId === blockId && a.start <= offset && offset < a.end);
        if (hit) onHighlightClick(hit[0]);
      });
    },
    [readSelection, onSelect, onHighlightClick],
  );

  // Keyboard selection (Shift+arrows) also opens the menu.
  const onKeyUp = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.shiftKey || e.key === "Shift") onSelect(readSelection());
    },
    [readSelection, onSelect],
  );

  // ---- progress & current page
  const frame = useRef(0);
  const onScroll = useCallback(() => {
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      const scroller = scrollerRef.current;
      const article = articleRef.current;
      if (!scroller || !article) return;
      const max = scroller.scrollHeight - scroller.clientHeight;
      const fraction = max > 0 ? Math.min(1, Math.max(0, scroller.scrollTop / max)) : 1;
      let page: number | null = null;
      const breaks = article.querySelectorAll<HTMLElement>("[data-page-break]");
      if (breaks.length) {
        page = 1;
        const line = scroller.getBoundingClientRect().top + scroller.clientHeight * 0.35;
        for (const b of breaks) {
          if (b.getBoundingClientRect().top > line) break;
          page = Number(b.dataset.pageBreak);
        }
      }
      onScrollProgress(fraction, page);
      onSelect(null);
    });
  }, [onScrollProgress, onSelect]);

  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  return (
    <div ref={scrollerRef} onScroll={onScroll} className="h-full overflow-y-auto">
      <article
        ref={articleRef}
        onMouseUp={onPointerUp}
        onTouchEnd={onPointerUp}
        onKeyUp={onKeyUp}
        className="mx-auto px-6 pt-10 font-serif text-body sm:pt-14"
        style={{ fontSize, lineHeight, maxWidth: width + 48, paddingBottom: bottomPadding }}
        lang={lang}
      >
        {header}
        <ImagesContext.Provider value={images}>
          {blocks.map((b) => (
            <BlockView key={b.id} block={b} />
          ))}
        </ImagesContext.Provider>
        <p className="mt-11 select-none font-sans text-[13px] text-muted">{t("reader.tip")}</p>
      </article>
    </div>
  );
}

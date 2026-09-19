"use client";

import { Fragment, memo, useCallback, useEffect, useImperativeHandle, useRef } from "react";

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
import type { Block, Inline } from "@/lib/markdown";

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
        <p {...common} className="mb-[18px]">
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
        <div {...common} className="mb-[18px] overflow-x-auto">
          <table className="w-full border-collapse font-sans text-[0.8em]">
            <tbody>
              {block.rows.map((row, r) => (
                <tr key={r} className={r === 0 ? "bg-soft font-medium" : ""}>
                  {row.map((cell, c) => (
                    <td key={c} className="border border-line px-2 py-1 align-top">
                      <Inlines nodes={cell} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "pagebreak":
      return (
        <div
          data-page-break={block.page}
          className="my-10 flex select-none items-center gap-3 font-sans text-xs text-muted"
          aria-label={`Trang ${block.page}`}
        >
          <span className="h-px flex-1 bg-line" />
          Trang {block.page}
          <span className="h-px flex-1 bg-line" />
        </div>
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
  bottomPadding,
}: {
  handleRef: React.Ref<CleanReaderHandle>;
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
  bottomPadding: number;
}) {
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
        lang="vi"
      >
        {header}
        {blocks.map((b) => (
          <BlockView key={b.id} block={b} />
        ))}
        <p className="mt-11 select-none font-sans text-[13px] text-muted">Mẹo: bôi đen một câu để highlight, ghi chú hoặc sao chép.</p>
      </article>
    </div>
  );
}

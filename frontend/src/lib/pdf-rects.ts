/** FR-HL-01 step 2: PDF highlight positions as rectangles normalised to 0..1 of the page size. */

export interface PdfRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const MAX_RECTS = 200;

const round = (v: number) => Math.round(v * 1e5) / 1e5;
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/**
 * Join the many small boxes a text selection produces (one per text-layer span) into one box per line.
 * Boxes on the same line are merged when they overlap or sit within about a space of each other.
 */
export function mergeRects(rects: PdfRect[]): PdfRect[] {
  const sorted = rects.filter((r) => r.w > 0 && r.h > 0).sort((a, b) => a.y + a.h / 2 - (b.y + b.h / 2) || a.x - b.x);
  const lines: PdfRect[] = [];
  for (const r of sorted) {
    const last = lines[lines.length - 1];
    const sameLine = last && Math.abs(last.y + last.h / 2 - (r.y + r.h / 2)) < Math.min(last.h, r.h) * 0.5;
    const close = last && r.x <= last.x + last.w + Math.max(last.h, r.h) * 0.8;
    if (last && sameLine && close) {
      const x = Math.min(last.x, r.x);
      const y = Math.min(last.y, r.y);
      last.w = Math.max(last.x + last.w, r.x + r.w) - x;
      last.h = Math.max(last.y + last.h, r.y + r.h) - y;
      last.x = x;
      last.y = y;
    } else {
      lines.push({ ...r });
    }
  }
  return lines;
}

/** Client rectangles of the text inside `range` (element boxes are skipped), relative to `page`, normalised. */
export function rangeRects(range: Range, page: HTMLElement): PdfRect[] {
  const box = page.getBoundingClientRect();
  if (!box.width || !box.height) return [];
  const out: PdfRect[] = [];
  const root = range.commonAncestorContainer;
  const walker = document.createTreeWalker(root.nodeType === Node.TEXT_NODE ? root.parentNode! : root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
    if (!n.data.trim() || !range.intersectsNode(n)) continue;
    const part = document.createRange();
    part.selectNodeContents(n);
    if (n === range.startContainer) part.setStart(n, range.startOffset);
    if (n === range.endContainer) part.setEnd(n, range.endOffset);
    for (const r of part.getClientRects()) {
      if (r.width < 0.5 || r.height < 0.5) continue;
      const x = clamp01((r.left - box.left) / box.width);
      const y = clamp01((r.top - box.top) / box.height);
      out.push({
        x: round(x),
        y: round(y),
        w: round(Math.min(1 - x, r.width / box.width)),
        h: round(Math.min(1 - y, r.height / box.height)),
      });
    }
  }
  return mergeRects(out)
    .filter((r) => r.w > 0 && r.h > 0)
    .slice(0, MAX_RECTS);
}

/** Is the normalised point inside one of the rectangles (with a little tolerance)? */
export function hitRects(rects: PdfRect[], px: number, py: number, pad = 0.002): boolean {
  return rects.some((r) => px >= r.x - pad && px <= r.x + r.w + pad && py >= r.y - pad && py <= r.y + r.h + pad);
}

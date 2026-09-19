/**
 * Case- and diacritic-insensitive find (SRS FR-RDR-04), highlighted with the CSS Custom Highlight API
 * so React-owned DOM and the PDF.js text layer are never mutated.
 */

interface Normalized {
  text: string;
  /** map[i] = index in the original string of normalized char i */
  map: number[];
}

export function normalize(s: string): string {
  return s
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[đĐ]/g, "d")
    .toLowerCase();
}

function normalizeWithMap(s: string): Normalized {
  let text = "";
  const map: number[] = [];
  let i = 0;
  for (const ch of s) {
    const n = normalize(ch);
    for (let k = 0; k < n.length; k++) map.push(i);
    text += n;
    i += ch.length;
  }
  map.push(s.length);
  return { text, map };
}

function matchesIn(haystack: string, { text, map }: Normalized, q: string): [number, number][] {
  if (!q) return [];
  const out: [number, number][] = [];
  let from = 0;
  for (;;) {
    const at = text.indexOf(q, from);
    if (at < 0) break;
    const endNorm = at + q.length;
    // end = right after the original char that produced the last normalized char (plus its combining marks)
    const lastOrig = map[endNorm - 1];
    let end = lastOrig + (haystack.codePointAt(lastOrig)! > 0xffff ? 2 : 1);
    while (end < haystack.length && !normalize(haystack[end])) end++;
    out.push([map[at], end]);
    from = endNorm;
  }
  return out;
}

/** Non-overlapping matches as [start, end) offsets in the original string. */
export function findMatches(haystack: string, query: string): [number, number][] {
  return matchesIn(haystack, normalizeWithMap(haystack), normalize(query.trim()));
}

/**
 * Like findMatches, but whitespace is ignored on both sides: PDF text layers often drop the break
 * between the last word of a line and the first of the next, and selections add their own newlines.
 */
export function findLoose(haystack: string, needle: string): [number, number][] {
  const full = normalizeWithMap(haystack);
  let text = "";
  const map: number[] = [];
  for (let i = 0; i < full.text.length; i++) {
    if (/\s/.test(full.text[i])) continue;
    text += full.text[i];
    map.push(full.map[i]);
  }
  map.push(haystack.length);
  return matchesIn(haystack, { text, map }, normalize(needle).replace(/\s+/g, ""));
}

/** Build DOM ranges for matches of `query` inside `root`'s text. */
export function findRanges(root: Node, query: string, match = findMatches): Range[] {
  const nodes: Text[] = [];
  const starts: number[] = [];
  let full = "";
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const t = n as Text;
    if (!t.data) continue;
    nodes.push(t);
    starts.push(full.length);
    full += t.data;
  }
  if (!nodes.length) return [];

  const locate = (offset: number, isEnd: boolean): [Text, number] => {
    let lo = 0;
    let hi = nodes.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] < offset || (!isEnd && starts[mid] === offset)) lo = mid;
      else hi = mid - 1;
    }
    return [nodes[lo], offset - starts[lo]];
  };

  return match(full, query).map(([s, e]) => {
    const range = document.createRange();
    const [sn, so] = locate(s, false);
    const [en, eo] = locate(e, true);
    range.setStart(sn, so);
    range.setEnd(en, eo);
    return range;
  });
}

const ALL = "pm-find";
const CURRENT = "pm-find-current";

export function supportsHighlights(): boolean {
  return typeof CSS !== "undefined" && "highlights" in CSS && typeof Highlight !== "undefined";
}

export function paintHighlights(ranges: Range[], current: Range | null) {
  if (!supportsHighlights()) return;
  // Above reader highlights (priority 0-1) so matches stay visible inside highlighted passages.
  const all = new Highlight(...ranges);
  all.priority = 2;
  CSS.highlights.set(ALL, all);
  if (current) {
    const cur = new Highlight(current);
    cur.priority = 3;
    CSS.highlights.set(CURRENT, cur);
  } else CSS.highlights.delete(CURRENT);
}

export function clearHighlights() {
  if (!supportsHighlights()) return;
  CSS.highlights.delete(ALL);
  CSS.highlights.delete(CURRENT);
}

/** Scroll so the range sits roughly in the middle of `scroller`. */
export function scrollRangeIntoView(scroller: HTMLElement, range: Range) {
  const rect = range.getBoundingClientRect();
  const box = scroller.getBoundingClientRect();
  if (rect.top >= box.top + 60 && rect.bottom <= box.bottom - 60) return;
  scroller.scrollTo({ top: scroller.scrollTop + rect.top - box.top - box.height / 2, behavior: "auto" });
}

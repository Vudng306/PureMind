/**
 * Where a highlight sits in the text as it is now (AN-102, AN-104, TSD §5.2).
 *
 * A highlight is put back only where that is sure: at its stored position while the words there are still
 * its words, otherwise at the one place in the document that holds its passage. When the passage is found in
 * several places and the words around it do not settle which, or when it is not found at all, the highlight
 * is not placed: it keeps its quote and is shown as needing a look, never painted on a guess.
 *
 * Plain strings in, plain positions out, so the rule is tested without a page.
 */

import { findLoose, normalize } from "./find";

/** One block of the clean text, in reading order. */
export interface TextBlock {
  id: string;
  text: string;
  page: number;
}

export interface Spot {
  blockId: string;
  start: number;
  end: number;
}

export interface Anchored {
  blockId: string | null;
  start: number | null;
  end: number | null;
  text: string;
  page: number | null;
  prefix?: string | null;
  suffix?: string | null;
}

export type Placement =
  /** `exact`: the stored position still holds. `moved`: found again, at the one place it can be. */
  | { state: "exact" | "moved"; spot: Spot; /** Every part, when it runs over several blocks. */ spots?: Spot[] }
  /** `review`: more than one place fits and nothing says which. `lost`: the passage is not in the text. */
  | { state: "review" | "lost"; spot: null };

/** A highlight that could not be placed, as the reader is told about it. */
export type AnchorIssue = "review" | "lost";

/** How much text on each side of a passage is kept with it. */
export const CONTEXT = 32;
/** How much of that has to agree for a side to count: text further away may have changed. */
const AGREE = 12;
/** A passage this long (letters, no spaces) is its own proof when it is found once. */
const LONG = 20;

const squash = (s: string) => normalize(s).replace(/\s+/g, "");

/** White space, and what a line end or a typesetter puts inside a word (services/anchors.py `LEFT_OUT`). */
const LEFT_OUT = /[\s\x1c-\x1f\x85\-\u2010\u2011\u00ad\u2063\u200b\u200c\u200d\ufeff]/gu;

/**
 * The words without spacing, hyphens, case or accents, as the server compares the clean text and the PDF
 * (`anchors.squash`). Positions in this form count code points, as the server's do.
 */
export function canon(text: string): string {
  return text
    .normalize("NFKC")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase()
    .replace(LEFT_OUT, "")
    .replace(/ς/g, "σ");
}

/** The length of `canon(text)`, in the positions the server counts. */
export const canonLength = (text: string) => [...canon(text)].length;

/** A part of a passage in one block, in `canon` positions (the server's `clean_anchor`). */
export interface CleanSpan {
  block: string;
  start: number;
  end: number;
}

interface CanonText {
  chars: string[];
  /** Where each of `chars` comes from in the block's text. */
  from: number[];
  to: number[];
}

const canonTexts = new WeakMap<TextBlock, CanonText>();

function canonOf(block: TextBlock): CanonText {
  let out = canonTexts.get(block);
  if (out) return out;
  out = { chars: [], from: [], to: [] };
  for (let i = 0; i < block.text.length; ) {
    const c = String.fromCodePoint(block.text.codePointAt(i) as number);
    const next = i + c.length;
    const made = [...canon(c)];
    for (const m of made) {
      out.chars.push(m);
      out.from.push(i);
      out.to.push(next);
    }
    // An accent written apart belongs to its letter.
    if (!made.length && /\p{M}/u.test(c) && out.to.length) out.to[out.to.length - 1] = next;
    i = next;
  }
  canonTexts.set(block, out);
  return out;
}

/**
 * The places in the page's text of a passage the server has placed, or null. Each part has to read as the
 * passage does; when the page shows a block a little differently, a part is taken only from the one place of
 * that block that holds exactly its words.
 */
export function spotsFromAnchor(blocks: TextBlock[], text: string, spans: CleanSpan[]): Spot[] | null {
  const words = [...canon(text)];
  const out: Spot[] = [];
  let at = 0;
  for (const span of spans) {
    const size = span.end - span.start;
    const part = words.slice(at, at + size).join("");
    at += size;
    const block = blocks.find((b) => b.id === span.block);
    if (!block || size <= 0) return null;
    const map = canonOf(block);
    let first = span.start;
    if (map.chars.slice(first, span.end).join("") !== part) {
      const all = map.chars.join("");
      const found = part ? all.indexOf(part) : -1;
      if (found < 0 || all.indexOf(part, found + 1) >= 0) return null;
      first = [...all.slice(0, found)].length;
    }
    const start = map.from[first];
    const end = map.to[first + size - 1];
    if (start === undefined || end === undefined) return null;
    out.push({ blockId: block.id, start, end });
  }
  return out.length && at === words.length ? out : null;
}

/** The words right before and after [start, end) in a block, kept with a new highlight. */
export function contextOf(text: string, start: number, end: number): { prefix: string; suffix: string } {
  let prefix = text.slice(Math.max(0, start - CONTEXT), start);
  let suffix = text.slice(end, end + CONTEXT);
  // Never half of a character that takes two units (an emoji, a rare ideograph).
  if (/^[\uDC00-\uDFFF]/.test(prefix)) prefix = prefix.slice(1);
  if (/[\uD800-\uDBFF]$/.test(suffix)) suffix = suffix.slice(0, -1);
  return { prefix, suffix };
}

interface Candidate extends Spot {
  block: TextBlock;
}

function occurrences(blocks: TextBlock[], text: string): Candidate[] {
  const out: Candidate[] = [];
  if (!text) return out;
  for (const block of blocks) {
    for (let i = block.text.indexOf(text); i >= 0; i = block.text.indexOf(text, i + text.length)) {
      out.push({ block, blockId: block.id, start: i, end: i + text.length });
    }
  }
  if (out.length) return out;
  // The same words with other spacing, case or accents (a PDF selection, a re-read page).
  for (const block of blocks) {
    for (const [start, end] of findLoose(block.text, text)) out.push({ block, blockId: block.id, start, end });
  }
  return out;
}

/** How many sides (0–2) of a candidate read like the words that were around the highlight. */
function agreement(c: Candidate, h: Anchored): number {
  const before = squash(h.prefix ?? "").slice(-AGREE);
  const after = squash(h.suffix ?? "").slice(0, AGREE);
  let n = 0;
  if (before && squash(c.block.text.slice(Math.max(0, c.start - CONTEXT * 2), c.start)).endsWith(before)) n++;
  if (after && squash(c.block.text.slice(c.end, c.end + CONTEXT * 2)).startsWith(after)) n++;
  return n;
}

const spotOf = ({ blockId, start, end }: Candidate): Spot => ({ blockId, start, end });

export function locate(blocks: TextBlock[], h: Anchored): Placement {
  if (h.blockId !== null && h.start !== null && h.end !== null) {
    const own = blocks.find((b) => b.id === h.blockId);
    if (own && own.text.slice(h.start, h.end) === h.text) {
      return { state: "exact", spot: { blockId: own.id, start: h.start, end: h.end } };
    }
  }

  const found = occurrences(blocks, h.text);
  if (!found.length) return { state: "lost", spot: null };
  const hasContext = Boolean(squash(h.prefix ?? "") || squash(h.suffix ?? ""));

  if (found.length === 1) {
    const only = found[0];
    // A long passage found once is that passage. A few words found once may be the same words somewhere
    // else, now that their own place is gone: those need the text around them, or their page, to agree.
    const sure =
      squash(h.text).length >= LONG ||
      (hasContext ? agreement(only, h) > 0 : h.page === null || only.block.page === h.page);
    return sure ? { state: "moved", spot: spotOf(only) } : { state: "review", spot: null };
  }

  if (hasContext) {
    const scored = found.map((c) => ({ c, n: agreement(c, h) }));
    const best = Math.max(...scored.map((s) => s.n));
    const top = scored.filter((s) => s.n === best);
    if (best > 0 && top.length === 1) return { state: "moved", spot: spotOf(top[0].c) };
  } else if (h.page !== null) {
    // A highlight made on a PDF page has no words around it, but it has its page.
    const onPage = found.filter((c) => c.block.page === h.page);
    if (onPage.length === 1) return { state: "moved", spot: spotOf(onPage[0]) };
  }
  return { state: "review", spot: null };
}

"use client";

import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useMemo } from "react";

import { useAuth } from "@/components/auth-provider";

import { ApiError, api } from "./api";
import { documentsKey } from "./documents";
import { findLoose, supportsHighlights } from "./find";
import type { PdfRect } from "./pdf-rects";
import { MSG } from "./messages";
import { HIGHLIGHT_COLORS, currentLang, type HighlightColor } from "./preferences";
import type { DocumentDetail, Lang } from "./types";
import { useUi } from "./ui-store";

/** Highlights are stored on the server; edits show at once and are sent in the background. */

export interface Highlight {
  id: string;
  docId: string;
  /** Clean-text position: data-block-id of the block holding the passage (null for PDF-page highlights) */
  blockId: string | null;
  /** [start, end) character offsets in the block's text */
  start: number | null;
  end: number | null;
  /** Original-PDF position on page `page`, normalised to the page size (null for clean-text highlights) */
  rects: PdfRect[] | null;
  text: string;
  color: HighlightColor;
  category: HighlightCategory | null;
  note: string;
  page: number | null;
  createdAt: string;
}

/** FR-HL-04: what kind of passage it is, independent of its color. */
export type HighlightCategory = "important" | "concept" | "question" | "example" | "review";
export const CATEGORIES: HighlightCategory[] = ["important", "concept", "question", "example", "review"];
export const CATEGORY_LABEL: Record<Lang, Record<HighlightCategory, string>> = {
  vi: {
    important: "Quan trọng",
    concept: "Khái niệm",
    question: "Câu hỏi",
    example: "Ví dụ",
    review: "Cần ôn tập",
  },
  en: {
    important: "Important",
    concept: "Concept",
    question: "Question",
    example: "Example",
    review: "To review",
  },
};

/** The name of a category in the language chosen right now. */
export function categoryLabel(category: HighlightCategory, lang: Lang = currentLang()): string {
  return CATEGORY_LABEL[lang][category];
}

/**
 * The color a reader picks already says what they meant by the passage, so it also sets the category.
 * Only the category reaches the AI: a color means whatever that one reader decided it means, while
 * `category` is the same five values for everyone (FR-HL-04, FR-NB-02).
 *
 * Every highlight gets its color's category and nothing in the UI sets one by hand, so the five colors
 * and the five categories are one choice for the reader. They remain two fields (FR-HL-04): a renamed
 * color label never changes the value the AI reads.
 */
export const CATEGORY_FOR_COLOR: Record<HighlightColor, HighlightCategory> = {
  yellow: "important",
  green: "example",
  blue: "concept",
  pink: "question",
  purple: "review",
};

export interface HighlightDto {
  id: string;
  document_id: string;
  block_id: string | null;
  start_offset: number | null;
  end_offset: number | null;
  rects: PdfRect[] | null;
  selected_text: string;
  color: HighlightColor;
  category: HighlightCategory | null;
  note: string;
  page_number: number | null;
  created_at: string;
}

export interface HighlightPage {
  items: HighlightDto[];
  total: number;
}

export const highlightsKey = ["highlights"] as const;
export const MAX_HIGHLIGHT_NOTE = 10000;
export const MAX_SELECTION = 5000;

export const fromDto = (h: HighlightDto): Highlight => ({
  id: h.id,
  docId: h.document_id,
  blockId: h.block_id,
  start: h.start_offset,
  end: h.end_offset,
  rects: h.rects ?? null,
  text: h.selected_text,
  color: h.color,
  category: h.category ?? null,
  note: h.note,
  page: h.page_number,
  createdAt: h.created_at,
});

export const toDto = (h: Omit<Highlight, "createdAt">) => ({
  id: h.id,
  document_id: h.docId,
  block_id: h.blockId,
  start_offset: h.start,
  end_offset: h.end,
  rects: h.rects,
  selected_text: h.text,
  color: h.color,
  category: h.category,
  note: h.note,
  page_number: h.page,
});

export function newId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID(); // secure contexts only
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const hex = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Every page of GET /highlights (500 per request). */
async function fetchAllHighlights(): Promise<Highlight[]> {
  const out: Highlight[] = [];
  for (let page = 1; ; page++) {
    const res = await api<HighlightPage>(`/highlights?page_size=500&page=${page}`);
    out.push(...res.items.map(fromDto));
    if (!res.items.length || out.length >= res.total) return out;
  }
}

/** All of the user's highlights (one cached list, shared by the reader, library and quick search). */
export function useHighlights(docId?: string) {
  const { session } = useAuth();
  const query = useQuery({
    queryKey: highlightsKey,
    queryFn: fetchAllHighlights,
    enabled: Boolean(session),
  });
  const all = query.data;
  const data = useMemo(() => (all && docId ? all.filter((h) => h.docId === docId) : (all ?? [])), [all, docId]);
  return { ...query, data };
}

// ---- writes: optimistic cache update, request queued per highlight

type Patch = Partial<Pick<Highlight, "color" | "category" | "note">>;

/** Requests for one highlight run in order (create → edits → delete). */
const chains = new Map<string, Promise<unknown>>();
const pending = new Map<string, { patch: Patch; timer: ReturnType<typeof setTimeout>; qc: QueryClient }>();

function enqueue(id: string, run: () => Promise<unknown>, qc: QueryClient) {
  const next = (chains.get(id) ?? Promise.resolve())
    .catch(() => undefined)
    .then(run)
    .catch((e: unknown) => {
      // Validation errors carry their own message (MSG-22, MSG-24); anything else is a save failure.
      useUi.getState().showToast(e instanceof ApiError && e.status === 422 ? e.message : MSG["MSG-23"]);
      void qc.invalidateQueries({ queryKey: highlightsKey });
    });
  chains.set(id, next);
  void next.finally(() => {
    if (chains.get(id) === next) chains.delete(id);
  });
}

function flush(id: string) {
  const p = pending.get(id);
  if (!p) return;
  clearTimeout(p.timer);
  pending.delete(id);
  const { note, ...fields } = p.patch;
  if (Object.keys(fields).length) {
    enqueue(id, () => api(`/highlights/${id}`, { method: "PATCH", body: JSON.stringify(fields) }), p.qc);
  }
  if (note !== undefined) {
    // FR-NOTE-01: one note per highlight; saving it empty deletes it.
    enqueue(
      id,
      () =>
        note.trim()
          ? api(`/highlights/${id}/note`, { method: "PUT", body: JSON.stringify({ content: note }) })
          : api(`/highlights/${id}/note`, { method: "DELETE" }),
      p.qc,
    );
  }
}

export function flushHighlightEdits() {
  for (const id of [...pending.keys()]) flush(id);
}

if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushHighlightEdits();
  });
}

const edit = (qc: QueryClient, fn: (list: Highlight[]) => Highlight[]) =>
  qc.setQueryData<Highlight[]>(highlightsKey, (old) => fn(old ?? []));

export function useHighlightActions() {
  const qc = useQueryClient();
  return useMemo(
    () => ({
      addHighlight(
        input: Omit<Highlight, "id" | "createdAt" | "note" | "category"> & {
          note?: string;
          category?: HighlightCategory | null;
        },
      ): Highlight {
        const h: Highlight = { note: "", category: null, ...input, id: newId(), createdAt: new Date().toISOString() };
        edit(qc, (list) => [...list, h]);
        enqueue(h.id, () => api("/highlights", { method: "POST", body: JSON.stringify(toDto(h)) }), qc);
        return h;
      },
      /** Color and category changes are sent at once; note typing is batched unless `now` is set. */
      updateHighlight(id: string, patch: Patch, { now = false } = {}) {
        edit(qc, (list) => list.map((h) => (h.id === id ? { ...h, ...patch } : h)));
        const prev = pending.get(id);
        if (prev) clearTimeout(prev.timer);
        const merged = { ...prev?.patch, ...patch };
        const delay = "note" in patch && !now ? 700 : 0;
        pending.set(id, { patch: merged, qc, timer: setTimeout(() => flush(id), delay) });
        if (now) flush(id);
      },
      removeHighlight(id: string) {
        const p = pending.get(id);
        if (p) clearTimeout(p.timer);
        pending.delete(id);
        edit(qc, (list) => list.filter((h) => h.id !== id));
        enqueue(id, () => api(`/highlights/${id}`, { method: "DELETE" }), qc);
      },
    }),
    [qc],
  );
}

/** Save the whole-document note and keep the cached document in step. */
export async function saveDocumentNote(qc: QueryClient, docId: string, note: string) {
  const doc = await api<DocumentDetail>(`/documents/${docId}`, { method: "PATCH", body: JSON.stringify({ note }) });
  qc.setQueryData<DocumentDetail>([...documentsKey, "detail", docId], (old) => (old ? { ...old, note: doc.note } : old));
}

// ---- DOM helpers (clean-text reader)

export const blockOf = (node: Node | null): HTMLElement | null =>
  (node instanceof Element ? node : node?.parentElement)?.closest<HTMLElement>("[data-block-id]") ?? null;

/** Character offset of (node, offset) inside `block`, counted the same way as Range.toString(). */
export function offsetIn(block: HTMLElement, node: Node, offset: number): number {
  const r = document.createRange();
  r.setStart(block, 0);
  r.setEnd(node, offset);
  return r.toString().length;
}

export interface Anchor {
  blockId: string;
  start: number;
  end: number;
}

const blockEl = (root: HTMLElement, id: string) => root.querySelector<HTMLElement>(`[data-block-id="${CSS.escape(id)}"]`);

/** DOM range for block offsets; null if the block is gone or shorter than the offsets. */
export function rangeAt(root: HTMLElement, h: Anchor): Range | null {
  const block = blockEl(root, h.blockId);
  if (!block) return null;
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  let pos = 0;
  let started = false;
  for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
    const len = n.data.length;
    if (!started && h.start <= pos + len) {
      range.setStart(n, h.start - pos);
      started = true;
    }
    if (started && h.end <= pos + len) {
      range.setEnd(n, h.end - pos);
      return range;
    }
    pos += len;
  }
  return null;
}

/** Range for block offsets, only if the text there still equals `text`. */
export function rangeFor(root: HTMLElement, h: Anchor & { text: string }): Range | null {
  const range = rangeAt(root, h);
  return range && range.toString() === h.text ? range : null;
}

/** Match of `text` in `haystack` closest to `near` (exact first, then ignoring whitespace/case/diacritics). */
function nearestMatch(haystack: string, text: string, near: number): [number, number] | null {
  let best: [number, number] | null = null;
  for (let i = haystack.indexOf(text); i >= 0; i = haystack.indexOf(text, i + 1)) {
    if (!best || Math.abs(i - near) < Math.abs(best[0] - near)) best = [i, i + text.length];
  }
  if (best) return best;
  for (const m of findLoose(haystack, text)) {
    if (!best || Math.abs(m[0] - near) < Math.abs(best[0] - near)) best = m;
  }
  return best;
}

/**
 * FR-HL-02: where a highlight sits in the clean text now. Stored offsets first; otherwise the passage is
 * looked up in its own block, then in the blocks of its page, then anywhere. Highlights made on the PDF
 * page have no offsets and are always looked up. Null means it cannot be placed.
 */
export function resolveAnchor(
  root: HTMLElement,
  h: Pick<Highlight, "blockId" | "start" | "end" | "text" | "page">,
): Anchor | null {
  if (h.blockId !== null && h.start !== null && h.end !== null) {
    const stored = { blockId: h.blockId, start: h.start, end: h.end };
    if (rangeFor(root, { ...stored, text: h.text })) return stored;
  }
  const own = h.blockId ? blockEl(root, h.blockId) : null;
  // Blocks in reading order with their page (page breaks carry data-page-break).
  const onPage: HTMLElement[] = [];
  const rest: HTMLElement[] = [];
  let page = 1;
  for (const el of root.querySelectorAll<HTMLElement>("[data-block-id], [data-page-break]")) {
    if (el.dataset.pageBreak) page = Number(el.dataset.pageBreak);
    else if (el !== own) (h.page === page ? onPage : rest).push(el);
  }
  for (const block of [own, ...onPage, ...rest]) {
    if (!block?.dataset.blockId) continue;
    const m = nearestMatch(block.textContent ?? "", h.text, block === own ? (h.start ?? 0) : 0);
    if (!m) continue;
    const anchor = { blockId: block.dataset.blockId, start: m[0], end: m[1] };
    if (rangeAt(root, anchor)) return anchor;
  }
  return null;
}

/** Paint highlights by color; the active one also gets an underline, `flash` a short strong tint. */
export function paintAnnotations(
  ranges: { color: HighlightColor; range: Range }[],
  active: Range | null,
  flash: Range | null = null,
) {
  if (!supportsHighlights()) return;
  for (const color of HIGHLIGHT_COLORS) {
    const hl = new Highlight(...ranges.filter((r) => r.color === color).map((r) => r.range));
    hl.priority = 0;
    CSS.highlights.set(`pm-hl-${color}`, hl);
  }
  if (active) {
    const hl = new Highlight(active);
    hl.priority = 1;
    CSS.highlights.set("pm-hl-active", hl);
  } else CSS.highlights.delete("pm-hl-active");
  if (flash) {
    const hl = new Highlight(flash);
    hl.priority = 2;
    CSS.highlights.set("pm-hl-flash", hl);
  } else CSS.highlights.delete("pm-hl-flash");
}

export function clearAnnotations() {
  if (!supportsHighlights()) return;
  for (const color of HIGHLIGHT_COLORS) CSS.highlights.delete(`pm-hl-${color}`);
  CSS.highlights.delete("pm-hl-active");
  CSS.highlights.delete("pm-hl-flash");
}

/** Caret position under the pointer (Chrome/Safari use caretRangeFromPoint, Firefox caretPositionFromPoint). */
export function caretAt(x: number, y: number): { node: Node; offset: number } | null {
  const doc = document as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
  };
  if (doc.caretPositionFromPoint) {
    const p = doc.caretPositionFromPoint(x, y);
    return p ? { node: p.offsetNode, offset: p.offset } : null;
  }
  const r = document.caretRangeFromPoint?.(x, y);
  return r ? { node: r.startContainer, offset: r.startOffset } : null;
}

"use client";

import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";

import { useAuth } from "@/components/auth-provider";

import {
  canon,
  locate,
  spotsFromAnchor,
  type AnchorIssue,
  type CleanSpan,
  type Placement,
  type Spot,
  type TextBlock,
} from "./anchor";
import { ApiError, api } from "./api";
import { supportsHighlights } from "./find";
import { createOutbox, mergeUnsaved, type Outbox, type Patch } from "./outbox";
import { sameArea, type PdfRect } from "./pdf-rects";
import { MSG } from "./messages";
import { HIGHLIGHT_COLORS, currentLang, type HighlightColor } from "./preferences";
import type { Lang } from "./types";
import { useUi } from "./ui-store";

/** Highlights are stored on the server; edits show at once and are sent in the background. */

/** Where a highlight shows on one page of the PDF, line by line. */
export interface PdfPlace {
  page: number;
  rects: PdfRect[];
}

/**
 * Synced: it shows in every view the document has. Unsynced: its place in the other view is not known.
 * Ambiguous: several places fit and none is chosen. The server decides; neither view guesses.
 */
export type SyncStatus = "synced" | "unsynced" | "ambiguous";

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
  /** The words right before and after the passage in its block, to find it again (AN-102). */
  prefix?: string | null;
  suffix?: string | null;
  /** Which text of the document it was made on, as the server names it. */
  contentVersion?: string | null;
  /** The passage itself, the same whichever view it was made in, and where it shows in each view. */
  canonicalStart?: number | null;
  canonicalEnd?: number | null;
  cleanAnchor?: CleanSpan[] | null;
  pdfAnchor?: PdfPlace[] | null;
  syncStatus?: SyncStatus | null;
  /** Answering a create only: the passage already had this highlight; the others it overlaps. */
  duplicate?: boolean;
  overlaps?: string[];
  /** AN-105: on its way to the server, or not saved after the tries. Absent once the server has it. */
  save?: "saving" | "failed";
  /** Why the server refused it, when it said. */
  saveError?: string;
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
  prefix?: string | null;
  suffix?: string | null;
  content_version?: string | null;
  /** Where the highlight stood when the file was last read again (UC-04); null before that. */
  anchor_status?: "mapped" | "ambiguous" | "unresolved" | null;
  canonical_start?: number | null;
  canonical_end?: number | null;
  clean_anchor?: CleanSpan[] | null;
  pdf_anchor?: PdfPlace[] | null;
  sync_status?: SyncStatus | null;
  duplicate?: boolean;
  overlaps?: string[];
}

export interface HighlightPage {
  items: HighlightDto[];
  total: number;
}

export const highlightsKey = ["highlights"] as const;
/** Everything the notebook pages read; refreshed whenever a highlight or a note changes. */
export const notebookKey = ["notebook"] as const;
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
  prefix: h.prefix ?? null,
  suffix: h.suffix ?? null,
  contentVersion: h.content_version ?? null,
  canonicalStart: h.canonical_start,
  canonicalEnd: h.canonical_end,
  cleanAnchor: h.clean_anchor,
  pdfAnchor: h.pdf_anchor,
  syncStatus: h.sync_status,
  ...(h.duplicate ? { duplicate: true } : {}),
  ...(h.overlaps?.length ? { overlaps: h.overlaps } : {}),
});

/** Where it shows on the PDF: where it was made there, or where the server found its passage. */
export const pdfPlaces = (h: Pick<Highlight, "rects" | "page" | "pdfAnchor">): PdfPlace[] =>
  h.rects && h.page ? [{ page: h.page, rects: h.rects }] : (h.pdfAnchor ?? []);

const inCleanText = (h: Pick<Highlight, "blockId" | "cleanAnchor">) => h.blockId !== null || Boolean(h.cleanAnchor?.length);

/** FR-05: the view this highlight could not be carried to, as the server found; null when there is none. */
export function missingView(h: Highlight): "clean" | "pdf" | null {
  if (h.syncStatus !== "unsynced" && h.syncStatus !== "ambiguous") return null;
  if (!inCleanText(h)) return "clean";
  return pdfPlaces(h).length ? null : "pdf";
}

/** FR-04: the view to open a highlight in: the one being read when it shows there, else the other. */
export function viewFor(h: Highlight, reading: "clean" | "original"): "clean" | "original" {
  const onPdf = pdfPlaces(h).length > 0;
  if (reading === "original") return onPdf || !inCleanText(h) ? "original" : "clean";
  return inCleanText(h) || !onPdf ? "clean" : "original";
}

/** A selection in either view, as far as telling which passage it is goes. */
export type PassagePick =
  | { blockId: string; start: number; end: number; canonStart: number; canonEnd: number }
  | { page: number; rects: PdfRect[]; text: string };

/** FR-02: this highlight is on exactly the passage selected. The same words elsewhere are another passage. */
export function samePassage(h: Highlight, sel: PassagePick): boolean {
  if ("rects" in sel) {
    const places = pdfPlaces(h);
    return places.length === 1 && places[0].page === sel.page && canon(h.text) === canon(sel.text) && sameArea(places[0].rects, sel.rects);
  }
  if (h.blockId === sel.blockId && h.start === sel.start && h.end === sel.end) return true;
  const only = h.cleanAnchor?.length === 1 ? h.cleanAnchor[0] : null;
  return only !== null && only.block === sel.blockId && only.start === sel.canonStart && only.end === sel.canonEnd;
}

/** What is sent to make a highlight. Which text it was made on is the server's to say, so it is not sent. */
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
  prefix: h.prefix || null,
  suffix: h.suffix || null,
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
    // What is still on its way is laid over the server's list, so a reload of the list never drops it.
    queryFn: async () => mergeUnsaved(await fetchAllHighlights(), box?.unsaved() ?? []),
    enabled: Boolean(session),
  });
  // Unsaved work belongs to the person who did it.
  const userId = session?.user.id ?? null;
  useEffect(() => {
    if (owner !== null && owner !== userId) box?.clear();
    owner = userId;
  }, [userId]);
  const all = query.data;
  const data = useMemo(() => (all && docId ? all.filter((h) => h.docId === docId) : (all ?? [])), [all, docId]);
  return { ...query, data };
}

// ---- writes: shown at once, saved in the background, marked until the server has answered (AN-105)

export type { Patch };

let box: Outbox | null = null;
let client: QueryClient | null = null;
let owner: string | null = null;

const show = (h: Highlight) =>
  client?.setQueryData<Highlight[]>(highlightsKey, (old = []) =>
    old.some((x) => x.id === h.id) ? old.map((x) => (x.id === h.id ? h : x)) : [...old, h],
  );

/** The highlight the passage already had takes the place of the one shown while waiting. */
const replace = (from: string, h: Highlight) =>
  client?.setQueryData<Highlight[]>(highlightsKey, (old = []) => {
    const rest = old.filter((x) => x.id !== from);
    return rest.some((x) => x.id === h.id) ? rest.map((x) => (x.id === h.id ? h : x)) : [...rest, h];
  });

function outbox(qc: QueryClient): Outbox {
  client = qc;
  return (box ??= createOutbox({
    wire: {
      create: async (h) => fromDto(await api<HighlightDto>("/highlights", { method: "POST", body: JSON.stringify(toDto(h)) })),
      patch: (id, fields) => api(`/highlights/${id}`, { method: "PATCH", body: JSON.stringify(fields) }),
      // FR-NOTE-01: one note per highlight; saving it empty deletes it.
      note: (id, note) =>
        note.trim()
          ? api(`/highlights/${id}/note`, { method: "PUT", body: JSON.stringify({ content: note }) })
          : api(`/highlights/${id}/note`, { method: "DELETE" }),
      remove: (id) => api(`/highlights/${id}`, { method: "DELETE" }),
    },
    put: show,
    moved: replace,
    saved(h) {
      show(h);
      void client?.invalidateQueries({ queryKey: notebookKey });
      // A list asked for before the save was answered would not have it: ask again.
      if (client?.isFetching({ queryKey: highlightsKey, exact: true })) {
        void client.invalidateQueries({ queryKey: highlightsKey, exact: true });
      }
    },
    failed(_h, e) {
      // Validation errors carry their own message (MSG-22, MSG-24); anything else is a save failure.
      useUi.getState().showToast(e instanceof ApiError && e.status === 422 ? e.message : MSG["MSG-23"]);
    },
  }));
}

export function flushHighlightEdits() {
  box?.flush();
}

if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushHighlightEdits();
  });
}

const cached = (qc: QueryClient, given: string) => {
  const id = box?.resolve(given) ?? given;
  return qc.getQueryData<Highlight[]>(highlightsKey)?.find((h) => h.id === id);
};

export function useHighlightActions() {
  const qc = useQueryClient();
  return useMemo(
    () => ({
      /**
       * `onSaved` is called once the server has the highlight, never before, with the highlight as saved: the
       * one the passage already had (`duplicate`) when it had one.
       */
      addHighlight(
        input: Omit<Highlight, "id" | "createdAt" | "note" | "category" | "save" | "saveError" | "contentVersion"> & {
          note?: string;
          category?: HighlightCategory | null;
        },
        { onSaved }: { onSaved?: (saved: Highlight) => void } = {},
      ): Highlight {
        const h: Highlight = { note: "", category: null, ...input, id: newId(), createdAt: new Date().toISOString() };
        outbox(qc).add(h, onSaved);
        return h;
      },
      /** Color and category changes are sent at once; note typing is batched unless `now` is set. */
      updateHighlight(id: string, patch: Patch, options: { now?: boolean; onSaved?: () => void } = {}) {
        const current = cached(qc, id);
        if (current) outbox(qc).edit(current, patch, options);
      },
      /** Send again a highlight, or an edit of one, that was not saved. */
      retryHighlight(id: string) {
        outbox(qc).retry(id);
      },
      /** `onDone` is called once the server has deleted it. */
      removeHighlight(given: string, { onDone }: { onDone?: () => void } = {}) {
        const id = outbox(qc).resolve(given);
        qc.setQueryData<Highlight[]>(highlightsKey, (old) => old?.filter((h) => h.id !== id));
        outbox(qc)
          .remove(id)
          .then(
            () => {
              onDone?.();
              void qc.invalidateQueries({ queryKey: notebookKey });
            },
            () => {
              // Still on the server: say so and show it again.
              useUi.getState().showToast(MSG["MSG-23"]);
              void qc.invalidateQueries({ queryKey: highlightsKey });
            },
          );
      },
    }),
    [qc],
  );
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

/** The blocks of the clean text in reading order, each with the page it is on (page breaks carry data-page-break). */
export function readBlocks(root: HTMLElement): TextBlock[] {
  const out: TextBlock[] = [];
  let page = 1;
  for (const el of root.querySelectorAll<HTMLElement>("[data-block-id], [data-page-break]")) {
    if (el.dataset.pageBreak) page = Number(el.dataset.pageBreak);
    else if (el.dataset.blockId) out.push({ id: el.dataset.blockId, text: el.textContent ?? "", page });
  }
  return out;
}

export type { AnchorIssue, Placement, Spot };

/**
 * FR-HL-02, AN-104: where a highlight sits in the clean text now, or why it is not placed (see `locate`).
 * `blocks` is read only when the stored position no longer holds; pass one reader for many highlights.
 */
export function placeHighlight(
  root: HTMLElement,
  h: Pick<Highlight, "blockId" | "start" | "end" | "text" | "page" | "prefix" | "suffix" | "cleanAnchor" | "syncStatus">,
  blocks: () => TextBlock[] = () => readBlocks(root),
): Placement {
  if (h.blockId !== null && h.start !== null && h.end !== null) {
    const stored = { blockId: h.blockId, start: h.start, end: h.end };
    if (rangeFor(root, { ...stored, text: h.text })) return { state: "exact", spot: stored };
  }
  if (h.cleanAnchor?.length) {
    const spots = spotsFromAnchor(blocks(), h.text, h.cleanAnchor);
    if (spots?.every((s) => rangeAt(root, s))) {
      return { state: h.blockId === null ? "exact" : "moved", spot: spots[0], spots };
    }
  }
  // Made on the PDF: only the server, which sees where on the page it was, can say where it is in the text.
  if (h.blockId === null) return { state: h.syncStatus === "ambiguous" ? "review" : "lost", spot: null };
  const placed = locate(blocks(), h);
  // A place the page cannot make a range for is no place.
  if (placed.spot && !rangeAt(root, placed.spot)) return { state: "lost", spot: null };
  return placed;
}

/** Paint highlights by color; the active one also gets an underline, `flash` a short strong tint. */
export function paintAnnotations(
  ranges: { color: HighlightColor; range: Range }[],
  active: Range | Range[] | null,
  flash: Range | Range[] | null = null,
) {
  if (!supportsHighlights()) return;
  for (const color of HIGHLIGHT_COLORS) {
    const hl = new Highlight(...ranges.filter((r) => r.color === color).map((r) => r.range));
    hl.priority = 0;
    CSS.highlights.set(`pm-hl-${color}`, hl);
  }
  const activeRanges = [active ?? []].flat();
  const flashRanges = [flash ?? []].flat();
  if (activeRanges.length) {
    const hl = new Highlight(...activeRanges);
    hl.priority = 1;
    CSS.highlights.set("pm-hl-active", hl);
  } else CSS.highlights.delete("pm-hl-active");
  if (flashRanges.length) {
    const hl = new Highlight(...flashRanges);
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

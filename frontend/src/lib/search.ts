import type { HighlightCategory } from "./annotations";
import type { HighlightColor } from "./preferences";

/** FR-SRCH-01: GET /search. */

export type SearchType = "document" | "highlight" | "note" | "summary" | "notebook";
export const SEARCH_TYPES: SearchType[] = ["document", "highlight", "note", "summary", "notebook"];
export const SEARCH_PAGE_SIZE = 10;
export const MIN_QUERY = 2;

export interface SearchHit {
  kind: "document" | "highlight" | "note" | "document_note" | "summary" | "notebook";
  id: string;
  /** null for a notebook, whose title is then in `document_title`. */
  document_id: string | null;
  document_title: string;
  file_type: "pdf" | "epub" | "web" | null;
  /** Matched words are wrapped in \x02 … \x03. */
  snippet: string;
  highlight_id: string | null;
  color: HighlightColor | null;
  category: HighlightCategory | null;
  page_number: number | null;
  created_at: string;
}

export interface SearchGroup {
  items: SearchHit[];
  total: number;
}

export interface SearchResults {
  query: string;
  documents: SearchGroup;
  highlights: SearchGroup;
  notes: SearchGroup;
  summaries: SearchGroup;
  notebooks: SearchGroup;
}

export const GROUP_OF: Record<SearchType, keyof Omit<SearchResults, "query">> = {
  document: "documents",
  highlight: "highlights",
  note: "notes",
  summary: "summaries",
  notebook: "notebooks",
};

export function searchPath(q: string, opts: { types?: SearchType[]; category?: HighlightCategory | null; page?: number } = {}) {
  const params = new URLSearchParams({ q });
  for (const t of opts.types ?? []) params.append("types", t);
  if (opts.category) params.set("category", opts.category);
  if (opts.page && opts.page > 1) params.set("page", String(opts.page));
  return `/search?${params}`;
}

/** Where a result opens: the reader, at the highlight when there is one, or with its summary panel open. */
export function hitHref(hit: SearchHit, q: string): string {
  if (hit.kind === "notebook") return `/notebooks/${hit.id}`;
  if (hit.highlight_id) return `/reader/${hit.document_id}?hl=${hit.highlight_id}`;
  if (hit.kind === "summary") return `/reader/${hit.document_id}?panel=summary`;
  if (hit.kind === "document") return `/reader/${hit.document_id}?q=${encodeURIComponent(q)}`;
  return `/reader/${hit.document_id}`;
}

const MARK_START = "\x02";
const MARK_END = "\x03";

/** Snippet text without Markdown syntax, split into plain and matched parts. */
export function snippetParts(snippet: string): { text: string; match: boolean }[] {
  const clean = snippet
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1") // [text](url) → text
    .replace(/^\s*(#{1,6}|>|[-*+]|\d+\.)\s+/gm, "") // heading, quote and list markers
    .replace(/^\s*(---|```)\s*$/gm, "") // page breaks, code fences
    .replace(/\*\*|__|`/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const parts: { text: string; match: boolean }[] = [];
  const re = new RegExp(`${MARK_START}([^${MARK_END}]*)${MARK_END}`, "g");
  let last = 0;
  for (const m of clean.matchAll(re)) {
    if (m.index > last) parts.push({ text: clean.slice(last, m.index), match: false });
    if (m[1]) parts.push({ text: m[1], match: true });
    last = m.index + m[0].length;
  }
  if (last < clean.length) parts.push({ text: clean.slice(last), match: false });
  // Stray markers (e.g. a cut-off headline) are dropped.
  return parts.map((p) => ({ ...p, text: p.text.replace(/[\x02\x03]/g, "") })).filter((p) => p.text);
}

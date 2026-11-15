"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";

import { fromDto, notebookKey, type Highlight, type HighlightDto } from "./annotations";
import { api } from "./api";
import { KIND_LABEL } from "./doc-view";
import type { Note } from "./notes";
import { colorLabel, currentLang, type HighlightColor } from "./preferences";
import type { Lang } from "./types";

/** The Notebook: the reader's highlights and notes, one group per document. A document is in it as soon as
 * it has one highlight, one note, or one thing kept from the AI. (The AI-written notebooks of before are in
 * lib/notebooks.ts and stay under /notebooks/archive.) */

export interface NotebookGroup {
  document_id: string;
  title: string;
  file_type: "pdf" | "epub" | "web";
  read_fraction: number | null;
  is_read: boolean;
  highlight_count: number;
  /** The reader's own notes: those written on a highlight plus the free ones. */
  note_count: number;
  /** Notes kept from the AI. */
  insight_count: number;
  /** With a search: how many of its highlights and notes match. */
  match_count: number | null;
  last_activity_at: string;
}

interface GroupPage {
  items: NotebookGroup[];
  total: number;
}

interface GroupDetailDto {
  group: NotebookGroup;
  highlights: HighlightDto[];
  notes: Note[];
}

export interface NotebookDocument {
  group: NotebookGroup;
  highlights: Highlight[];
  notes: Note[];
}

export type NotebookSort = "document" | "newest";

const PAGE_SIZE = 200; // the API's largest page

export function useNotebookGroups(q: string) {
  const query = q.trim();
  return useQuery({
    queryKey: [...notebookKey, "groups", query],
    queryFn: () => {
      const params = new URLSearchParams({ page_size: String(PAGE_SIZE) });
      if (query) params.set("q", query);
      return api<GroupPage>(`/notebook/documents?${params}`);
    },
    placeholderData: keepPreviousData,
  });
}

/** One document's page of the notebook, in reading order or newest first. */
export function useNotebookDocument(docId: string, sort: NotebookSort) {
  return useQuery({
    queryKey: [...notebookKey, "document", docId, sort],
    queryFn: async (): Promise<NotebookDocument> => {
      const d = await api<GroupDetailDto>(`/notebook/documents/${docId}?sort=${sort}`);
      return { group: d.group, highlights: d.highlights.map(fromDto), notes: d.notes };
    },
    placeholderData: keepPreviousData,
    retry: false, // "not in the notebook" is an answer, not a failure to try again
  });
}

/**
 * The server decides the order; what is shown is the live copy. An edit made on this page (or in the reader,
 * in another tab of the app) shows at once, a deleted item leaves at once, and a new one waits at the end
 * until the server has placed it.
 */
export function inOrder<T extends { id: string }>(order: T[], live: T[] | undefined): T[] {
  if (!live) return order;
  const byId = new Map(live.map((x) => [x.id, x]));
  const placed = order.flatMap((x) => byId.get(x.id) ?? []);
  const known = new Set(order.map((x) => x.id));
  return [...placed, ...live.filter((x) => !known.has(x.id))];
}

/** Lower case, without accents: "Phương pháp" is found by "phuong phap". */
export function fold(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[đĐ]/g, "d")
    .toLowerCase();
}

/** Every word of the query is somewhere in the text. An empty query matches everything. */
export function matchesQuery(text: string, query: string): boolean {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const hay = fold(text);
  return words.every((w) => hay.includes(w));
}

export type ReadingState = "read" | "reading" | "unread";

export function readingState(g: Pick<NotebookGroup, "is_read" | "read_fraction">): ReadingState {
  if (g.is_read) return "read";
  return (g.read_fraction ?? 0) > 0 ? "reading" : "unread";
}

const AI_SOURCE: Record<Lang, Record<string, string>> = {
  vi: {
    quick: "Tóm tắt nhanh",
    deep: "Tóm tắt sâu",
    mindmap: "Mind Map",
    analysis: "Phân tích nghiên cứu",
    chat: "Trợ lý đọc",
    translation: "Bản dịch",
  },
  en: {
    quick: "Quick summary",
    deep: "Deep summary",
    mindmap: "Mind map",
    analysis: "Research analysis",
    chat: "Reading assistant",
    translation: "Translation",
  },
};

const quote = (s: string) =>
  s
    .trim()
    .split(/\r?\n/)
    .map((line) => (line.trim() ? `> ${line.trimEnd()}` : ">"))
    .join("\n");
const hardBreaks = (s: string) => s.trim().replace(/\r?\n/g, "  \n");

/** Where the export points back to (AN-110): the document's own address, and the reader in PureMind. */
export interface ExportLinks {
  source?: string | null;
  /** The reader's address for this document, e.g. https://…/reader/<id>; a highlight adds ?hl=<its id>. */
  reader?: string;
}

/** One document's notebook as Markdown: highlights with their notes, then the free notes, then what was kept
 * from the AI, which stays marked as such. Each highlight says where it is (its page) and links back to it. */
export function notebookMarkdown(
  doc: Pick<NotebookGroup, "title" | "file_type"> & ExportLinks,
  highlights: Highlight[],
  notes: Note[],
  labels: Record<HighlightColor, string>,
  now: Date = new Date(),
  lang: Lang = currentLang(),
): string {
  const en = lang === "en";
  const date = now.toLocaleDateString(en ? "en-GB" : "vi-VN", { day: "2-digit", month: "2-digit", year: "numeric" });
  const own = notes.filter((n) => n.origin === "user");
  const kept = notes.filter((n) => n.origin === "ai_saved");
  const lines = [
    `# ${doc.title.replace(/\s+/g, " ").trim()}`,
    "",
    en ? `${KIND_LABEL[doc.file_type]} · Notebook exported from PureMind on ${date}` : `${KIND_LABEL[doc.file_type]} · Notebook xuất từ PureMind ngày ${date}`,
  ];
  const source = doc.source && /^https?:\/\//i.test(doc.source) ? doc.source : null;
  if (source) lines.push(`${en ? "Source" : "Nguồn"}: <${source}>  `);
  if (doc.reader) lines.push(`${en ? "Open in PureMind" : "Mở trong PureMind"}: <${doc.reader}>`);
  if (highlights.length) {
    lines.push("", en ? "## Highlights" : "## Highlight", "");
    highlights.forEach((h, i) => {
      if (i > 0) lines.push("", "---", "");
      lines.push(quote(h.text), "");
      const page = h.page ? (en ? `Page ${h.page}` : `Trang ${h.page}`) : null;
      const back = doc.reader ? `[${en ? "Open this passage" : "Mở đoạn này"}](${doc.reader}?hl=${h.id})` : null;
      lines.push(`*${[page, colorLabel(labels, h.color, lang)].filter(Boolean).join(" · ")}*${back ? ` · ${back}` : ""}`);
      if (h.note.trim()) lines.push("", `**${en ? "Note" : "Ghi chú"}:** ${hardBreaks(h.note)}`);
    });
  }
  if (own.length) {
    lines.push("", en ? "## Notes" : "## Ghi chú tự do");
    for (const n of own) lines.push("", hardBreaks(n.body));
  }
  if (kept.length) {
    lines.push("", en ? "## Saved from AI" : "## Đã lưu từ AI");
    for (const n of kept) {
      const from = n.provenance ? AI_SOURCE[lang][n.provenance.source] : null;
      const translated = n.provenance?.source === "translation";
      const by = translated ? (en ? "Translated by AI" : "AI dịch") : en ? "Written by AI" : "AI viết";
      lines.push("", `*${[by, from].filter(Boolean).join(" · ")}*`);
      // A translation keeps the passage it translates, as it is in the document.
      if (translated && n.provenance?.quote) lines.push("", quote(n.provenance.quote));
      lines.push("", hardBreaks(n.body));
      for (const c of n.provenance?.citations ?? []) {
        const text = c.text.replace(/\s+/g, " ").trim();
        lines.push(`  \n[${c.position}] “${text.length > 200 ? `${text.slice(0, 200)}…` : text}”`);
      }
    }
  }
  return `${lines.join("\n")}\n`;
}

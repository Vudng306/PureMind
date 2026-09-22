import { categoryLabel, fromDto, type Highlight, type HighlightCategory, type HighlightPage } from "./annotations";
import { api } from "./api";
import { KIND_LABEL } from "./doc-view";
import { colorLabel, currentLang, type HighlightColor } from "./preferences";
import type { Lang } from "./types";

/** F-35: highlights and their notes as a Markdown file. */

export interface ExportDoc {
  title: string;
  file_type: "pdf" | "epub" | "web";
  url: string | null;
}

export interface ExportFilter {
  documentId?: string;
  category?: HighlightCategory;
  color?: HighlightColor;
}

const EXPORT_PAGE = 500; // the API's largest page

/** Every highlight matching the filter, grouped by document then page (the API's "document" order). */
export async function fetchAllHighlights(filter: ExportFilter): Promise<Highlight[]> {
  const out: Highlight[] = [];
  for (let page = 1; ; page++) {
    const params = new URLSearchParams({ sort: "document", page: String(page), page_size: String(EXPORT_PAGE) });
    if (filter.documentId) params.set("document_id", filter.documentId);
    if (filter.category) params.set("category", filter.category);
    if (filter.color) params.set("color", filter.color);
    const res = await api<HighlightPage>(`/highlights?${params}`);
    out.push(...res.items.map(fromDto));
    if (res.items.length < EXPORT_PAGE || out.length >= res.total) return out;
  }
}

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
const quote = (s: string) =>
  s
    .trim()
    .split(/\r?\n/)
    .map((line) => (line.trim() ? `> ${line.trimEnd()}` : ">"))
    .join("\n");

export function highlightsMarkdown(
  highlights: Highlight[],
  docs: Map<string, ExportDoc>,
  labels: Record<HighlightColor, string>,
  filter: ExportFilter = {},
  now: Date = new Date(),
  lang: Lang = currentLang(),
): string {
  const en = lang === "en";
  const groups = new Map<string, Highlight[]>();
  for (const h of highlights) {
    const list = groups.get(h.docId);
    if (list) list.push(h);
    else groups.set(h.docId, [h]);
  }

  const date = en
    ? now.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })
    : now.toLocaleDateString("vi-VN", { day: "2-digit", month: "2-digit", year: "numeric" });
  const filters = [
    filter.category && categoryLabel(filter.category, lang),
    filter.color &&
      (en ? `${colorLabel(labels, filter.color, lang)}` : `màu ${colorLabel(labels, filter.color, lang)}`),
  ].filter(Boolean);
  const count = en
    ? `${highlights.length} highlight${highlights.length === 1 ? "" : "s"}`
    : `${highlights.length} highlight`;
  const lines = [
    en ? "# Highlights" : "# Highlight",
    "",
    en
      ? `Exported from PureMind on ${date} · ${count}${filters.length ? ` · Filters: ${filters.join(", ")}` : ""}`
      : `Xuất từ PureMind ngày ${date} · ${count}${filters.length ? ` · Bộ lọc: ${filters.join(", ")}` : ""}`,
  ];

  for (const [docId, items] of groups) {
    const doc = docs.get(docId);
    lines.push("", `## ${oneLine(doc?.title ?? (en ? "Document" : "Tài liệu"))}`, "");
    if (doc) lines.push(`${KIND_LABEL[doc.file_type]}${doc.url ? ` · <${doc.url}>` : ""}`, "");
    items.forEach((h, i) => {
      if (i > 0) lines.push("", "---", "");
      lines.push(quote(h.text), "");
      const pageLabel = h.page ? (en ? `Page ${h.page}` : `Trang ${h.page}`) : null;
      const meta = [pageLabel, colorLabel(labels, h.color, lang), h.category && categoryLabel(h.category, lang)];
      lines.push(`*${meta.filter(Boolean).join(" · ")}*`);
      // Line breaks in the note are kept as Markdown hard breaks.
      if (h.note.trim())
        lines.push("", `**${en ? "Note" : "Ghi chú"}:** ${h.note.trim().replace(/\r?\n/g, "  \n")}`);
    });
  }
  return `${lines.join("\n")}\n`;
}

/** A file name safe on every OS, e.g. "puremind-highlight-giao-trinh-hoc-may-2026-09-19.md". */
export function exportFileName(title: string | null, now: Date = new Date()): string {
  const slug = (title ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[đĐ]/g, "d")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/, "");
  const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  return `puremind-highlight${slug ? `-${slug}` : ""}-${day}.md`;
}

export function downloadText(text: string, fileName: string, type = "text/markdown;charset=utf-8") {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

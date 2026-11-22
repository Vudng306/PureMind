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

/** The source a notebook's [n] points at, as much of it as the export needs. */
export interface ExportSource {
  position: number;
  document_title: string;
  highlight: { id: string; document_id: string; selected_text: string; page_number: number | null };
}

const SOURCE_QUOTE_CHARS = 300;

/**
 * FR-NB-03: the notebook as the author left it, as a Markdown file. The text goes out as written; the passages
 * its [n] cite follow under "Sources", so the numbers still mean something outside PureMind. `origin` (the
 * app's address) adds a link back to each passage in the reader.
 */
export function notebookExportMarkdown(
  title: string,
  content: string,
  sources: ExportSource[],
  now: Date = new Date(),
  lang: Lang = currentLang(),
  origin?: string,
): string {
  const en = lang === "en";
  const name = oneLine(title) || "Notebook";
  const body = content.trim();
  const firstLine = body.split(/\r?\n/, 1)[0] ?? "";
  // The AI writes the title as the first heading; a notebook typed by hand may not have one.
  const heading = /^#\s+/.test(firstLine) ? "" : `# ${name}\n\n`;
  const lines = [`${heading}${body}`];

  const cited = new Set([...body.matchAll(/\[(\d{1,3})\]/g)].map((m) => Number(m[1])));
  const used = sources.filter((s) => cited.has(s.position)).sort((a, b) => a.position - b.position);
  if (used.length) {
    lines.push("", "---", "", en ? "## Sources" : "## Nguồn", "");
    for (const s of used) {
      const text = oneLine(s.highlight.selected_text);
      const cut = text.length > SOURCE_QUOTE_CHARS ? `${text.slice(0, SOURCE_QUOTE_CHARS).trimEnd()}…` : text;
      const page = s.highlight.page_number ? (en ? `, page ${s.highlight.page_number}` : `, trang ${s.highlight.page_number}`) : "";
      const link = origin ? ` · <${origin}/reader/${s.highlight.document_id}?hl=${s.highlight.id}>` : "";
      lines.push(`${s.position}. “${cut}” — *${oneLine(s.document_title)}*${page}${link}`);
    }
  }

  const date = en
    ? now.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })
    : now.toLocaleDateString("vi-VN", { day: "2-digit", month: "2-digit", year: "numeric" });
  lines.push("", en ? `*Exported from PureMind on ${date}*` : `*Xuất từ PureMind ngày ${date}*`);
  return `${lines.join("\n")}\n`;
}

/** A file name safe on every OS, e.g. "puremind-highlight-giao-trinh-hoc-may-2026-09-19.md". */
export function exportFileName(
  title: string | null,
  now: Date = new Date(),
  prefix: "puremind-highlight" | "puremind-notebook" = "puremind-highlight",
  extension: "md" | "docx" = "md",
): string {
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
  return `${prefix}${slug ? `-${slug}` : ""}-${day}.${extension}`;
}

export function downloadText(text: string, fileName: string, type = "text/markdown;charset=utf-8") {
  downloadBlob(new Blob([text], { type }), fileName);
}

export function downloadBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

import { describe, expect, it } from "vitest";

import type { Highlight } from "./annotations";
import { progressOf, readStateOf } from "./doc-view";
import { exportFileName, highlightsMarkdown, notebookExportMarkdown, type ExportDoc, type ExportSource } from "./export";
import { DEFAULT_COLOR_LABELS } from "./preferences";
import type { DocumentListItem } from "./types";

const hl = (over: Partial<Highlight>): Highlight => ({
  id: "h",
  docId: "d1",
  blockId: "b1",
  start: 0,
  end: 5,
  rects: null,
  text: "đoạn",
  color: "yellow",
  category: null,
  note: "",
  page: null,
  createdAt: "2026-09-19T00:00:00Z",
  ...over,
});

describe("highlightsMarkdown", () => {
  const docs = new Map<string, ExportDoc>([
    ["d1", { title: "Giáo trình\nhọc máy", file_type: "pdf", url: null }],
    ["d2", { title: "Bài viết", file_type: "web", url: "https://example.org/a" }],
  ]);
  const now = new Date(2026, 8, 19);

  it("groups by document and keeps passages, labels and notes", () => {
    const md = highlightsMarkdown(
      [
        hl({ id: "1", text: "Dòng một\nDòng hai", page: 3, category: "concept", note: "ý 1\ný 2" }),
        hl({ id: "2", text: "Thứ hai", color: "green" }),
        hl({ id: "3", docId: "d2", text: "Trên web" }),
      ],
      docs,
      { ...DEFAULT_COLOR_LABELS.vi, yellow: "Ý chính" },
      { category: "concept" },
      now,
    );
    expect(md).toContain("Xuất từ PureMind ngày 19/09/2026 · 3 highlight · Bộ lọc: Khái niệm");
    expect(md).toContain("## Giáo trình học máy\n\nPDF\n\n> Dòng một\n> Dòng hai\n\n*Trang 3 · Ý chính · Khái niệm*");
    expect(md).toContain("**Ghi chú:** ý 1  \ný 2");
    expect(md).toContain("\n---\n\n> Thứ hai\n");
    expect(md).toContain("## Bài viết\n\nWEB · <https://example.org/a>\n\n> Trên web");
    expect(md.indexOf("## Giáo trình")).toBeLessThan(md.indexOf("## Bài viết"));
    expect(md.endsWith("\n")).toBe(true);
  });

  it("handles an empty export", () => {
    expect(highlightsMarkdown([], docs, DEFAULT_COLOR_LABELS.vi, {}, now)).toContain("0 highlight");
  });
});

describe("notebookExportMarkdown", () => {
  const now = new Date(2026, 8, 19);
  const src = (position: number, text: string, page: number | null = null): ExportSource => ({
    position,
    document_title: "Giáo trình\nhọc máy",
    highlight: { id: `h${position}`, document_id: "d1", selected_text: text, page_number: page },
  });

  it("exports the edited text as written, then the passages it cites", () => {
    const md = notebookExportMarkdown(
      "Học máy",
      "# Học máy\n\nMô hình học từ dữ liệu [2]. Em tự viết thêm câu này.\n",
      [src(1, "không được trích"), src(2, "Dòng một\nDòng hai", 4)],
      now,
      "vi",
      "https://app.example",
    );
    expect(md.startsWith("# Học máy\n\nMô hình học từ dữ liệu [2]. Em tự viết thêm câu này.\n")).toBe(true);
    expect(md).toContain(
      "## Nguồn\n\n2. “Dòng một Dòng hai” — *Giáo trình học máy*, trang 4 · <https://app.example/reader/d1?hl=h2>",
    );
    expect(md).not.toContain("không được trích");
    expect(md).toContain("*Xuất từ PureMind ngày 19/09/2026*");
    expect(md.endsWith("\n")).toBe(true);
  });

  it("adds the title when the text has no heading, and no source list when nothing is cited", () => {
    const md = notebookExportMarkdown("Ghi chép", "Chỉ có chữ.", [src(1, "x")], now, "en");
    expect(md.startsWith("# Ghi chép\n\nChỉ có chữ.\n")).toBe(true);
    expect(md).not.toContain("## Sources");
    expect(md).toContain("*Exported from PureMind on");
  });
});

describe("exportFileName", () => {
  const now = new Date(2026, 8, 19);
  it("slugs Vietnamese titles", () => {
    expect(exportFileName("Đọc hiểu: Học máy (2026)!", now)).toBe("puremind-highlight-doc-hieu-hoc-may-2026-2026-09-19.md");
    expect(exportFileName(null, now)).toBe("puremind-highlight-2026-09-19.md");
    expect(exportFileName("Học máy", now, "puremind-notebook")).toBe("puremind-notebook-hoc-may-2026-09-19.md");
    expect(exportFileName("Học máy", now, "puremind-notebook", "docx")).toBe("puremind-notebook-hoc-may-2026-09-19.docx");
  });
});

describe("read state", () => {
  const doc = (over: Partial<DocumentListItem>) => ({ page_count: 10, last_read_page: null, read_fraction: null, is_read: false, ...over }) as DocumentListItem;
  it("only is_read counts as finished", () => {
    expect(progressOf(doc({ last_read_page: 10 }))).toBe(99);
    expect(readStateOf(doc({ last_read_page: 10 }))).toBe("reading");
    expect(readStateOf(doc({ last_read_page: 10, is_read: true }))).toBe("read");
    expect(readStateOf(doc({}))).toBe("unread");
    expect(progressOf(doc({ page_count: null, read_fraction: 0.5 }))).toBe(50);
  });
});

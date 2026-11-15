import { describe, expect, it } from "vitest";

import type { Highlight } from "./annotations";
import { fold, inOrder, matchesQuery, notebookMarkdown, readingState } from "./notebook";
import { savedAs, splitNotes, type Note } from "./notes";
import { DEFAULT_COLOR_LABELS } from "./preferences";
import { findSnippet } from "./reader-ai";

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
  createdAt: "2026-11-13T00:00:00Z",
  ...over,
});

const note = (over: Partial<Note>): Note => ({
  id: "n",
  document_id: "d1",
  body: "ghi chú",
  origin: "user",
  provenance: null,
  created_at: "2026-11-13T00:00:00Z",
  updated_at: "2026-11-13T00:00:00Z",
  ...over,
});

const kept = note({
  id: "n2",
  body: "Mô hình cần dữ liệu sạch. [1]",
  origin: "ai_saved",
  provenance: {
    source: "quick",
    source_id: "art-1",
    part: "takeaway:0",
    model: "gpt",
    language: "vi",
    generated_at: null,
    citations: [{ position: 1, page_number: 3, heading: null, text: "Dữ liệu sạch quyết định   chất lượng mô hình." }],
  },
});

describe("inOrder", () => {
  const order = [{ id: "a", v: 1 }, { id: "b", v: 1 }, { id: "c", v: 1 }];

  it("keeps the server's order when nothing live is known yet", () => {
    expect(inOrder(order, undefined)).toBe(order);
  });

  it("shows the live copy, drops what was deleted and puts what is new at the end", () => {
    const live = [{ id: "d", v: 2 }, { id: "c", v: 2 }, { id: "a", v: 2 }];
    expect(inOrder(order, live)).toEqual([{ id: "a", v: 2 }, { id: "c", v: 2 }, { id: "d", v: 2 }]);
  });
});

describe("matchesQuery", () => {
  it("ignores case and accents", () => {
    expect(fold("Phương PHÁP Đo")).toBe("phuong phap do");
    expect(matchesQuery("Phương pháp nghiên cứu", "phuong phap")).toBe(true);
  });

  it("needs every word, in any order", () => {
    expect(matchesQuery("dữ liệu sạch cho mô hình", "mô hình dữ liệu")).toBe(true);
    expect(matchesQuery("dữ liệu sạch", "dữ liệu bẩn")).toBe(false);
  });

  it("matches everything when the query is empty", () => {
    expect(matchesQuery("bất kỳ", "   ")).toBe(true);
  });
});

describe("readingState", () => {
  it("tells read, reading and unread apart", () => {
    expect(readingState({ is_read: true, read_fraction: 0.2 })).toBe("read");
    expect(readingState({ is_read: false, read_fraction: 0.2 })).toBe("reading");
    expect(readingState({ is_read: false, read_fraction: null })).toBe("unread");
  });
});

describe("notes helpers", () => {
  it("separates the reader's notes from the ones kept from the AI", () => {
    const { own, ai } = splitNotes([note({ id: "n1" }), kept]);
    expect(own.map((n) => n.id)).toEqual(["n1"]);
    expect(ai.map((n) => n.id)).toEqual(["n2"]);
  });

  it("finds the note a piece was saved as", () => {
    expect(savedAs([note({}), kept], "art-1", "takeaway:0")?.id).toBe("n2");
    expect(savedAs([note({}), kept], "art-1", "takeaway:1")).toBeUndefined();
    expect(savedAs(undefined, "art-1", "takeaway:0")).toBeUndefined();
  });

  it("takes the first words of a passage to find it again", () => {
    expect(findSnippet("  một hai ba bốn năm sáu bảy tám chín mười ")).toBe("một hai ba bốn năm sáu bảy tám");
  });

  it("searches for the words as they are shown, without the Markdown marks", () => {
    expect(findSnippet("**Lợi ích:** Thí nghiệm cho người tham gia làm bài")).toBe("Lợi ích: Thí nghiệm cho người tham gia");
    expect(findSnippet("- xem [bài gốc](https://example.org/a) và `mã` này nhé")).toBe("xem bài gốc và mã này nhé");
  });

  it("takes the words from one line, past a short heading", () => {
    expect(findSnippet("## Kết quả\n\nNhóm gộp thông báo làm việc tốt hơn hẳn nhóm còn lại.")).toBe(
      "Nhóm gộp thông báo làm việc tốt hơn",
    );
    expect(findSnippet("## Kết quả")).toBe("Kết quả");
    expect(findSnippet("")).toBe("");
  });
});

describe("notebookMarkdown", () => {
  const doc = { title: "Giáo trình\nhọc máy", file_type: "pdf" as const };
  const now = new Date(2026, 10, 13);

  it("writes highlights with their notes, then free notes, then what was kept from the AI", () => {
    const md = notebookMarkdown(
      doc,
      [hl({ id: "h1", text: "Đoạn một", note: "ý của tôi\ndòng hai", page: 4 }), hl({ id: "h2", text: "Đoạn hai", color: "blue" })],
      [note({ id: "n1", body: "ghi chú tự do" }), kept],
      DEFAULT_COLOR_LABELS.vi,
      now,
      "vi",
    );
    expect(md.startsWith("# Giáo trình học máy\n")).toBe(true);
    expect(md).toContain("PDF · Notebook xuất từ PureMind ngày 13/11/2026");
    expect(md).toContain("> Đoạn một");
    expect(md).toContain("Trang 4");
    expect(md).toContain("**Ghi chú:** ý của tôi  \ndòng hai");
    expect(md.indexOf("## Highlight")).toBeLessThan(md.indexOf("## Ghi chú tự do"));
    expect(md.indexOf("## Ghi chú tự do")).toBeLessThan(md.indexOf("## Đã lưu từ AI"));
    // What the AI wrote stays marked, with the passage it cited.
    expect(md).toContain("*AI viết · Tóm tắt nhanh*");
    expect(md).toContain("[1] “Dữ liệu sạch quyết định chất lượng mô hình.”");
  });

  it("leaves out the sections that are empty", () => {
    const md = notebookMarkdown(doc, [], [note({ body: "chỉ một ghi chú" })], DEFAULT_COLOR_LABELS.en, now, "en");
    expect(md).not.toContain("## Highlights");
    expect(md).not.toContain("## Saved from AI");
    expect(md).toContain("## Notes\n\nchỉ một ghi chú");
  });
});

describe("notebookMarkdown links and translations (AN-110)", () => {
  const now = new Date(2026, 10, 15);
  const translation = note({
    id: "n3",
    body: "Học máy là một ngành học.",
    origin: "ai_saved",
    provenance: {
      source: "translation",
      source_id: null,
      part: "vi",
      quote: "Machine learning is a field of study.",
      model: "gpt-test",
      language: "vi",
      generated_at: "2026-11-15T00:00:00Z",
      citations: [],
    },
  });

  it("points back to the source and to each highlight in the reader", () => {
    const md = notebookMarkdown(
      { title: "Bài", file_type: "web", source: "https://example.org/a", reader: "https://app.test/reader/d1" },
      [hl({ id: "h9", text: "Đoạn", page: 2 })],
      [],
      DEFAULT_COLOR_LABELS.vi,
      now,
      "vi",
    );
    expect(md).toContain("Nguồn: <https://example.org/a>");
    expect(md).toContain("Mở trong PureMind: <https://app.test/reader/d1>");
    expect(md).toContain("*Trang 2 · Ý chính* · [Mở đoạn này](https://app.test/reader/d1?hl=h9)");
  });

  it("keeps a translation beside its original, marked as the AI's", () => {
    const md = notebookMarkdown(
      { title: "Bài", file_type: "pdf", source: "file:///x" },
      [],
      [translation],
      DEFAULT_COLOR_LABELS.en,
      now,
      "en",
    );
    expect(md).not.toContain("Source:"); // only a web address is a source to follow
    expect(md).toContain(
      "*Translated by AI · Translation*\n\n> Machine learning is a field of study.\n\nHọc máy là một ngành học.",
    );
  });
});

import { unzipSync, strFromU8 } from "fflate";
import { Packer } from "docx";
import { describe, expect, it } from "vitest";

import type { ExportSource } from "./export";
import { notebookDocument } from "./notebook-docx";

const src = (position: number, text: string, page: number | null = null): ExportSource => ({
  position,
  document_title: "Giáo trình học máy",
  highlight: { id: `h${position}`, document_id: "d1", selected_text: text, page_number: page },
});

async function documentXml(...args: Parameters<typeof notebookDocument>): Promise<string> {
  const zip = unzipSync(new Uint8Array(await Packer.toBuffer(notebookDocument(...args))));
  return strFromU8(zip["word/document.xml"]);
}

describe("notebookDocument", () => {
  const content = [
    "# Học máy",
    "",
    "## Khái niệm chính",
    "",
    "Mô hình học từ dữ liệu [2][1]. Câu chưa có nguồn [7].",
    "",
    "1. Thu thập",
    "2. Huấn luyện",
  ].join("\n");

  it("opens with the title and the meta line, then the notebook's own headings", async () => {
    const xml = await documentXml({
      title: "Học máy",
      meta: ["Chủ đề hoặc dự án: Luận văn", "Tạo ngày 19/09/2026 · 1 nguồn"],
      content,
      sources: [src(1, "Đoạn một"), src(2, "Dòng một\nDòng hai", 4), src(3, "không được trích")],
      lang: "vi",
      origin: "https://app.example",
      now: new Date(2026, 8, 19),
    });
    expect(xml).toContain('w:val="Title"');
    // The leading H1 repeats the title, so it appears once.
    expect(xml.match(/>Học máy</g)).toHaveLength(1);
    expect(xml).toContain("Chủ đề hoặc dự án: Luận văn");
    expect(xml).toContain("Tạo ngày 19/09/2026 · 1 nguồn");
    expect(xml).toContain('w:val="Heading2"');
    expect(xml).toContain("Khái niệm chính");
    expect(xml).toContain("Thu thập");
    // [2] is a raised number linked to its passage; [7] has no source and stays plain.
    expect(xml).toContain('w:anchor="source_2"');
    expect(xml).toContain('w:vertAlign w:val="superscript"');
    // Two cites side by side keep a comma between them.
    expect(xml).toMatch(/source_2.*?<w:t[^>]*>,<\/w:t>.*?source_1/);
    expect(xml).not.toContain('w:anchor="source_7"');
    expect(xml).toContain('w:name="source_2"');
    expect(xml).toContain("Nguồn");
    expect(xml).toContain("“Dòng một Dòng hai” — ");
    expect(xml).toContain("Giáo trình học máy, trang 4");
    expect(xml).not.toContain("không được trích");
  });

  it("leaves out the source list when nothing is cited", async () => {
    const xml = await documentXml({ title: "Ghi chép", meta: ["Created 19 Sept 2026"], content: "Chỉ có chữ.", sources: [src(1, "x")], lang: "en" });
    expect(xml).toContain("Ghi chép");
    expect(xml).toContain("Chỉ có chữ.");
    expect(xml).not.toContain(">Sources<");
  });
});

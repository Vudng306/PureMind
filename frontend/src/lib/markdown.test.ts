import { describe, expect, it } from "vitest";

import { findMatches, normalize } from "./find";
import { parseInline, parseMarkdown } from "./markdown";

const NL = String.fromCharCode(10);

describe("parseMarkdown", () => {
  const md = [
    "# Chapter 1",
    "",
    "Machine **learning** is *fun*, see [docs](https://example.org) and [bad](javascript:alert(1)).",
    "",
    "- one",
    "  - nested",
    "",
    "| A | B |",
    "|---|---|",
    "| 1 | x<br>y |",
    "",
    "---",
    "",
    "```",
    "print('hi')",
    "```",
    "",
    "> quoted text",
  ].join("\n");

  it("parses the extractor subset into blocks", () => {
    const blocks = parseMarkdown(md);
    expect(blocks.map((b) => b.t)).toEqual(["heading", "paragraph", "list", "table", "pagebreak", "code", "quote"]);

    const table = blocks[3];
    expect(table.t === "table" && table.rows.length).toBe(2);
    const list = blocks[2];
    expect(list.t === "list" && list.items.map((i) => i.depth)).toEqual([0, 1]);
    const pb = blocks[4];
    expect(pb.t === "pagebreak" && pb.page).toBe(2);
  });

  it("drops unsafe link targets but keeps their text", () => {
    const para = parseMarkdown(md)[1];
    if (para.t !== "paragraph") throw new Error("expected paragraph");
    const links = para.c.filter((n) => n.t === "link");
    expect(links).toHaveLength(1);
    expect(links[0].t === "link" && links[0].href).toBe("https://example.org");
    expect(JSON.stringify(para.c)).not.toContain("javascript");
    expect(JSON.stringify(para.c)).toContain("bad");
  });

  it("makes an image its own block and refuses unsafe sources", () => {
    const blocks = parseMarkdown(
      [
        "Trước ảnh.",
        "",
        "![Biểu đồ doanh thu](https://cdn.example.org/a.jpg)",
        "",
        "![xấu](javascript:alert(1))",
      ].join(NL),
    );
    expect(blocks.map((b) => b.t)).toEqual(["paragraph", "image", "paragraph"]);
    const image = blocks[1];
    if (image.t !== "image") throw new Error("expected an image block");
    expect(image).toMatchObject({ src: "https://cdn.example.org/a.jpg", alt: "Biểu đồ doanh thu" });
  });

  it("keeps ids of other blocks when an image is added", () => {
    const before = parseMarkdown(["Đoạn một.", "", "Đoạn hai."].join(NL));
    const after = parseMarkdown(
      ["Đoạn một.", "", "![ảnh](https://cdn.example.org/a.jpg)", "", "Đoạn hai."].join(NL),
    );
    // Highlights are anchored by block id, so inserting an image must not move the text around it.
    expect([after[0].id, after[2].id]).toEqual([before[0].id, before[1].id]);
  });

  it("gives stable, unique block ids", () => {
    const a = parseMarkdown("Same\n\nSame\n\nOther");
    const b = parseMarkdown("Intro\n\nSame\n\nSame\n\nOther");
    expect(new Set(a.map((x) => x.id)).size).toBe(3);
    // unrelated insertion before does not change ids of existing blocks
    expect(b.slice(1).map((x) => x.id)).toEqual(a.map((x) => x.id));
  });

  it("handles escapes and snake_case", () => {
    expect(parseInline("a\\*b\\* snake_case_name")).toEqual([{ t: "text", v: "a*b* snake_case_name" }]);
  });
});

describe("find", () => {
  it("ignores case and Vietnamese diacritics", () => {
    expect(normalize("Học Máy ĐẸP")).toBe("hoc may dep");
    const text = "Học máy là gì? HOC MAY rất hay. hoc may!";
    const matches = findMatches(text, "học máy");
    expect(matches).toHaveLength(3);
    expect(matches.map(([s, e]) => text.slice(s, e))).toEqual(["Học máy", "HOC MAY", "hoc may"]);
  });

  it("maps offsets back for decomposed input", () => {
    const text = "Tiếng Việt"; // decomposed "Tiếng Việt"
    const [[s, e]] = findMatches(text, "việt");
    expect(text.slice(s, e).normalize("NFC")).toBe("Việt");
  });

  it("returns nothing for empty queries", () => {
    expect(findMatches("abc", "   ")).toEqual([]);
  });
});

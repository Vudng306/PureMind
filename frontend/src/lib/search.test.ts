import { describe, expect, it } from "vitest";

import { hitHref, searchPath, snippetParts, type SearchHit } from "./search";

describe("snippetParts", () => {
  it("splits on match markers and drops Markdown syntax", () => {
    const parts = snippetParts("# Học có \x02giám\x03 \x02sát\x03\n\nĐiểm nằm ở chữ **tổng quát hóa");
    expect(parts).toEqual([
      { text: "Học có ", match: false },
      { text: "giám", match: true },
      { text: " ", match: false },
      { text: "sát", match: true },
      { text: " Điểm nằm ở chữ tổng quát hóa", match: false },
    ]);
  });

  it("keeps link text and ignores stray markers", () => {
    expect(snippetParts("xem [tài liệu](https://x.y) \x02abc")).toEqual([{ text: "xem tài liệu abc", match: false }]);
  });
});

describe("links", () => {
  const hit = { document_id: "d1", highlight_id: null, kind: "document" } as SearchHit;

  it("opens highlights at the highlight and documents with in-page find", () => {
    expect(hitHref({ ...hit, kind: "note", highlight_id: "h1" }, "x")).toBe("/reader/d1?hl=h1");
    expect(hitHref(hit, "tổng quát")).toBe("/reader/d1?q=t%E1%BB%95ng%20qu%C3%A1t");
    expect(hitHref({ ...hit, kind: "document_note" }, "x")).toBe("/reader/d1");
    expect(hitHref({ ...hit, kind: "summary" }, "x")).toBe("/reader/d1?panel=summary");
    expect(hitHref({ ...hit, kind: "notebook", id: "n1", document_id: null }, "x")).toBe("/notebooks/n1");
  });

  it("builds the API path", () => {
    expect(searchPath("ab c", { types: ["note"], category: "question", page: 2 })).toBe(
      "/search?q=ab+c&types=note&category=question&page=2",
    );
  });
});

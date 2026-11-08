import { describe, expect, it } from "vitest";

import { NO_FILTERS, continueReading, filterDocuments, noDerivatives, recentDocuments } from "./library";
import type { DocumentListItem } from "./types";

function doc(over: Partial<DocumentListItem>): DocumentListItem {
  return {
    id: "d",
    title: "Tài liệu",
    source_type: "upload",
    file_type: "pdf",
    url: null,
    original_filename: "a.pdf",
    file_size: 1,
    page_count: 10,
    word_count: 100,
    reading_minutes: 1,
    extraction_status: "done",
    extraction_error: null,
    last_read_page: null,
    read_fraction: null,
    is_read: false,
    citation: null,
    collection_id: null,
    license: null,
    topics: [],
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...over,
  };
}

describe("continueReading", () => {
  it("lists what is started and unfinished, last touched first", () => {
    const docs = [
      doc({ id: "old", last_read_page: 3, updated_at: "2026-01-01T00:00:00Z" }),
      doc({ id: "new", last_read_page: 5, updated_at: "2026-02-01T00:00:00Z" }),
      doc({ id: "done", is_read: true, updated_at: "2026-03-01T00:00:00Z" }),
      doc({ id: "untouched", updated_at: "2026-04-01T00:00:00Z" }),
    ];
    expect(continueReading(docs).map((d) => d.id)).toEqual(["new", "old"]);
  });

  it("offers something unread when nothing is started", () => {
    expect(continueReading([doc({ id: "a", is_read: true }), doc({ id: "b" })]).map((d) => d.id)).toEqual(["b"]);
    expect(continueReading([doc({ is_read: true })])).toEqual([]);
  });

  it("skips what cannot be opened yet", () => {
    expect(continueReading([doc({ extraction_status: "processing", last_read_page: 3 })])).toEqual([]);
  });

  it("keeps to the limit", () => {
    const docs = ["a", "b", "c", "d"].map((id) => doc({ id, last_read_page: 2 }));
    expect(continueReading(docs, 3)).toHaveLength(3);
  });
});

describe("recentDocuments", () => {
  it("goes by when a document arrived, not when it was last read", () => {
    const docs = [
      doc({ id: "first", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-09-01T00:00:00Z" }),
      doc({ id: "second", created_at: "2026-02-01T00:00:00Z" }),
    ];
    expect(recentDocuments(docs).map((d) => d.id)).toEqual(["second", "first"]);
  });
});

describe("filterDocuments", () => {
  const docs = [
    doc({ id: "pdf", title: "Sinh học tế bào", collection_id: "c1", topics: ["science"] }),
    doc({ id: "web", title: "Bài báo", source_type: "manual", file_type: "web", url: "https://a.vn/x", is_read: true }),
  ];
  const ids = (over: Partial<typeof NO_FILTERS>) => filterDocuments(docs, { ...NO_FILTERS, ...over }).map((d) => d.id);

  it("narrows by each filter", () => {
    expect(ids({})).toEqual(["pdf", "web"]);
    expect(ids({ collection: "c1" })).toEqual(["pdf"]);
    expect(ids({ source: "manual" })).toEqual(["web"]);
    expect(ids({ fileType: "pdf" })).toEqual(["pdf"]);
    expect(ids({ topic: "science" })).toEqual(["pdf"]);
    expect(ids({ readState: "read" })).toEqual(["web"]);
  });

  it("finds by name without caring about accents", () => {
    expect(ids({ query: "sinh hoc" })).toEqual(["pdf"]);
    expect(ids({ query: "a.vn" })).toEqual(["web"]);
  });
});

describe("noDerivatives", () => {
  it("reads the licence", () => {
    expect(noDerivatives("CC BY-ND 4.0")).toBe(true);
    expect(noDerivatives("CC BY 4.0")).toBe(false);
    expect(noDerivatives(null)).toBe(false);
  });
});

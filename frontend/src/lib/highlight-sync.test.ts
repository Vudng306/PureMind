import { describe, expect, it, vi } from "vitest";

import { canon, canonLength, spotsFromAnchor, type TextBlock } from "./anchor";
import { fromDto, missingView, pdfPlaces, samePassage, viewFor, type Highlight, type HighlightDto } from "./annotations";
import { createOutbox, mergeUnsaved, type Wire } from "./outbox";
import { sameArea } from "./pdf-rects";

const hl = (over: Partial<Highlight> = {}): Highlight => ({
  id: "h1",
  docId: "d1",
  blockId: "b1",
  start: 0,
  end: 5,
  rects: null,
  text: "words",
  color: "yellow",
  category: "important",
  note: "",
  page: 1,
  createdAt: "2026-11-18T00:00:00.000Z",
  ...over,
});

const onPdf = (over: Partial<Highlight> = {}) =>
  hl({ blockId: null, start: null, end: null, rects: [{ x: 0.1, y: 0.1, w: 0.5, h: 0.02 }], ...over });

const settle = async () => {
  for (let i = 0; i < 50; i++) await Promise.resolve();
};

describe("canon", () => {
  // Written out by services/anchors.py `squash`: positions are only comparable if both sides agree.
  it.each([
    ["Học máy cơ bản", "hocmaycoban"],
    ["ĐẠI HỌC Đà Nẵng", "daihocdanang"],
    ["co-operate­tion  x​y", "cooperatetionxy"],
    ["ﬁnal ﬂow", "finalflow"],
    ["ΣΑΣ σας", "σασσασ"],
    ["été", "ete"],
    ["a b　c", "abc"],
    ["\u{1d4b3} emoji 😀 end", "xemoji😀end"],
    ["line-\nbreak", "linebreak"],
    ["Straße İstanbul", "straßeistanbul"],
  ])("reads %j as the server does", (text, expected) => {
    expect(canon(text)).toBe(expected);
  });

  it("counts code points, as the server's positions do", () => {
    expect(canonLength("a😀b")).toBe(3);
  });
});

describe("spotsFromAnchor", () => {
  const same = "Cùng một câu";
  const blocks: TextBlock[] = [
    { id: "b1", text: `Mở đầu. ${same} kết thúc.`, page: 1 },
    { id: "b2", text: `Đoạn khác. ${same} ở đây.`, page: 1 },
  ];
  const at = (id: string, words: string) => {
    const text = blocks.find((b) => b.id === id)!.text;
    const start = canonLength(text.slice(0, text.indexOf(words)));
    return { block: id, start, end: start + canonLength(words) };
  };

  it("TC-01: gives the offsets in the page's text of a passage made on the PDF", () => {
    const [spot] = spotsFromAnchor(blocks, same.toUpperCase(), [at("b1", same)])!;
    expect(blocks[0].text.slice(spot.start, spot.end)).toBe(same);
  });

  it("TC-07: keeps the same words in two blocks apart", () => {
    expect(spotsFromAnchor(blocks, same, [at("b1", same)])![0].blockId).toBe("b1");
    expect(spotsFromAnchor(blocks, same, [at("b2", same)])![0].blockId).toBe("b2");
  });

  it("TC-08: gives one place per block for a passage over two blocks", () => {
    const spots = spotsFromAnchor(blocks, "kết thúc. Đoạn khác.", [at("b1", "kết thúc."), at("b2", "Đoạn khác.")])!;
    expect(spots.map((s) => s.blockId)).toEqual(["b1", "b2"]);
  });

  it("keeps an accent written apart with its letter", () => {
    const block = { id: "b", text: "café noir", page: 1 };
    const [spot] = spotsFromAnchor([block], "cafe", [{ block: "b", start: 0, end: 4 }])!;
    expect(block.text.slice(spot.start, spot.end)).toBe("café");
  });

  it("finds a part again in its block only when it stands there once", () => {
    const shifted = { id: "b", text: "Thêm chữ. Một đoạn riêng.", page: 1 };
    const [spot] = spotsFromAnchor([shifted], "Một đoạn riêng", [{ block: "b", start: 0, end: 12 }])!;
    expect(shifted.text.slice(spot.start, spot.end)).toBe("Một đoạn riêng");
    const twice = { id: "b", text: "Hai lần. Hai lần.", page: 1 };
    expect(spotsFromAnchor([twice], "Hai lần", [{ block: "b", start: 3, end: 9 }])).toBeNull();
  });

  it("TC-12: gives no place when the words are not there", () => {
    expect(spotsFromAnchor(blocks, "Không có ở đâu", [{ block: "b1", start: 0, end: 11 }])).toBeNull();
    expect(spotsFromAnchor(blocks, same, [{ block: "gone", start: 0, end: 9 }])).toBeNull();
  });
});

describe("one highlight in both views", () => {
  const rects = [{ x: 0.1, y: 0.1, w: 0.5, h: 0.02 }];

  it("TC-02, TC-08: shows a highlight on every page the server placed it on", () => {
    const pdfAnchor = [
      { page: 1, rects },
      { page: 2, rects },
    ];
    expect(pdfPlaces(hl({ pdfAnchor })).map((p) => p.page)).toEqual([1, 2]);
    expect(pdfPlaces(onPdf({ page: 3 }))).toEqual([{ page: 3, rects }]);
    expect(pdfPlaces(hl())).toEqual([]);
  });

  it("TC-03: knows the passage from the other view", () => {
    const clean = { blockId: "b2", start: 9, end: 14, canonStart: 7, canonEnd: 12 };
    expect(samePassage(onPdf({ cleanAnchor: [{ block: "b2", start: 7, end: 12 }] }), clean)).toBe(true);
    expect(samePassage(hl({ pdfAnchor: [{ page: 1, rects }] }), { page: 1, rects, text: "WORDS" })).toBe(true);
  });

  it("TC-07: does not take the same words elsewhere for the passage", () => {
    const below = [{ x: 0.1, y: 0.6, w: 0.5, h: 0.02 }];
    expect(sameArea(rects, below)).toBe(false);
    expect(samePassage(hl({ pdfAnchor: [{ page: 1, rects }] }), { page: 1, rects: below, text: "words" })).toBe(false);
    const elsewhere = { blockId: "b3", start: 0, end: 5, canonStart: 0, canonEnd: 5 };
    expect(samePassage(onPdf({ cleanAnchor: [{ block: "b2", start: 0, end: 5 }] }), elsewhere)).toBe(false);
  });

  it("FR-04: opens in the view being read when the highlight shows there", () => {
    const both = onPdf({ cleanAnchor: [{ block: "b", start: 0, end: 5 }] });
    expect(viewFor(both, "clean")).toBe("clean");
    expect(viewFor(both, "original")).toBe("original");
    expect(viewFor(onPdf(), "clean")).toBe("original");
    expect(viewFor(hl(), "original")).toBe("clean");
  });

  it("TC-12: says which view a highlight could not reach", () => {
    expect(missingView(onPdf({ syncStatus: "unsynced" }))).toBe("clean");
    expect(missingView(onPdf({ syncStatus: "ambiguous" }))).toBe("clean");
    expect(missingView(hl({ syncStatus: "unsynced" }))).toBe("pdf");
    expect(missingView(hl({ syncStatus: "synced" }))).toBeNull();
    expect(missingView(hl())).toBeNull(); // not told yet
  });

  it("reads what the server says about a highlight", () => {
    const h = fromDto({
      id: "h",
      document_id: "d",
      block_id: null,
      start_offset: null,
      end_offset: null,
      rects,
      selected_text: "x",
      color: "yellow",
      category: null,
      note: "",
      page_number: 1,
      created_at: "t",
      clean_anchor: [{ block: "b", start: 4, end: 9 }],
      pdf_anchor: [{ page: 1, rects }],
      sync_status: "synced",
      duplicate: true,
      overlaps: ["o"],
    } satisfies HighlightDto);
    expect(h).toMatchObject({ syncStatus: "synced", duplicate: true, overlaps: ["o"] });
  });
});

describe("a passage that already has its highlight", () => {
  const existing = hl({ id: "old", color: "green", category: "example", note: "ghi chú cũ", syncStatus: "synced" });

  function setup(row: Highlight, over: Partial<Wire> = {}) {
    const wire = {
      create: vi.fn(async () => ({ ...row, duplicate: true })),
      patch: vi.fn(async () => undefined),
      note: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
      ...over,
    } satisfies Wire;
    const moved: [string, Highlight][] = [];
    const saved: Highlight[] = [];
    const box = createOutbox({
      wire,
      put: () => undefined,
      saved: (h) => saved.push(h),
      failed: () => undefined,
      moved: (from, h) => moved.push([from, h]),
      wait: async () => undefined,
    });
    return { box, wire, moved, saved };
  }

  it("TC-03, TC-11: takes its place and changes nothing on it", async () => {
    const { box, wire, moved, saved } = setup(existing);
    const told = vi.fn();
    box.add(onPdf({ id: "new", color: "blue", category: "concept", note: "" }), told);
    await settle();
    expect(moved[0][0]).toBe("new");
    expect(moved[0][1]).toMatchObject({ id: "old", color: "green" });
    expect(wire.patch).not.toHaveBeenCalled();
    expect(wire.note).not.toHaveBeenCalled();
    expect(saved[0]).toMatchObject({ id: "old", color: "green", note: "ghi chú cũ" });
    expect(saved[0].duplicate).toBeUndefined();
    expect(told.mock.calls[0][0]).toMatchObject({ id: "old", duplicate: true });
    expect(box.resolve("new")).toBe("old");
  });

  it("TC-04, TC-05: applies to that highlight what was changed while waiting", async () => {
    let answer: (h: Highlight) => void = () => undefined;
    const { box, wire } = setup(existing, {
      create: vi.fn(() => new Promise<Highlight>((r) => (answer = r))),
    });
    const mine = onPdf({ id: "new" });
    box.add(mine);
    await settle(); // the request has left
    box.edit(mine, { color: "pink", category: "question" });
    box.edit(mine, { note: "ghi chú mới" }, { now: true });
    await settle();
    answer({ ...existing, duplicate: true });
    await settle();
    expect(wire.patch).toHaveBeenCalledWith("old", { color: "pink", category: "question" });
    expect(wire.note).toHaveBeenCalledWith("old", "ghi chú cũ\n\nghi chú mới");
  });

  it("sends later edits and a delete under that highlight's id", async () => {
    const { box, wire } = setup(existing);
    const mine = onPdf({ id: "new" });
    box.add(mine);
    await settle();
    box.edit(mine, { color: "purple", category: "review" });
    await settle();
    expect(wire.patch).toHaveBeenCalledWith("old", { color: "purple", category: "review" });
    await box.remove("new");
    expect(wire.remove).toHaveBeenCalledWith("old");
  });

  it("TC-09: keeps the places from the server when a reload meets an edit on its way", () => {
    const server = hl({ syncStatus: "synced", cleanAnchor: [{ block: "b1", start: 0, end: 5 }] });
    const [merged] = mergeUnsaved([server], [{ h: hl({ color: "pink" }), create: false }]);
    expect(merged).toMatchObject({ color: "pink", syncStatus: "synced", cleanAnchor: server.cleanAnchor });
  });

  it("TC-01: a new highlight gets its places from the server's answer", async () => {
    const places = { syncStatus: "synced" as const, cleanAnchor: [{ block: "b1", start: 0, end: 5 }] };
    const mine = onPdf({ id: "new" });
    const { box, saved, moved } = setup(mine, { create: vi.fn(async (h: Highlight) => ({ ...h, ...places })) });
    box.add(mine);
    await settle();
    expect(moved).toEqual([]);
    expect(saved[0]).toMatchObject({ id: "new", ...places });
  });
});

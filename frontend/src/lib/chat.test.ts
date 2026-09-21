import { describe, expect, it } from "vitest";

import { citationLabel, citedSources, type ChatCitation } from "./chat";

const passage = (position: number, over: Partial<ChatCitation> = {}): ChatCitation => ({
  position,
  page_number: null,
  heading: null,
  text: `Đoạn ${position}`,
  ...over,
});

describe("citedSources", () => {
  it("lists the passages an answer cites, once each, in order of first use", () => {
    const citations = [passage(1), passage(2), passage(5)];
    const used = citedSources("Câu này [5] và câu kia [1][5], rồi [2].", citations);
    expect(used.map((c) => c.position)).toEqual([5, 1, 2]);
  });

  it("ignores numbers that were never given as passages", () => {
    expect(citedSources("Một [9] hai [1]", [passage(1)]).map((c) => c.position)).toEqual([1]);
    expect(citedSources("Không có trích dẫn.", [passage(1)])).toEqual([]);
  });
});

describe("citationLabel", () => {
  it("names a passage by page and heading when it has them", () => {
    expect(citationLabel(passage(3, { page_number: 12, heading: "Chương 2" }))).toBe("Trang 12 · Chương 2");
    expect(citationLabel(passage(3, { page_number: 12 }))).toBe("Trang 12");
    expect(citationLabel(passage(3, { heading: "Mở đầu" }))).toBe("Mở đầu");
    expect(citationLabel(passage(3))).toBe("Đoạn 3");
  });
});

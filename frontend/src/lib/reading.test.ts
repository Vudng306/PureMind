import { describe, expect, it } from "vitest";

import { isPartial, pageRuns, readOn, readOnPages, resumeOf, shownIssues, toPosition } from "./reading";

describe("resumeOf", () => {
  it("has nothing to go back to at the very start of a document", () => {
    expect(resumeOf({})).toBeNull();
    expect(resumeOf({ fraction: 0.001, page: 1 })).toBeNull();
  });

  it("keeps the clean-text place and the page", () => {
    const position = { block_id: "b1", offset: 0.4 };
    expect(resumeOf({ fraction: 0.42, position, page: 3 })).toEqual({ fraction: 0.42, position, page: 3 });
    expect(resumeOf({ page: 7 })).toEqual({ fraction: 0, position: null, page: 7 });
  });
});

describe("toPosition", () => {
  it("keeps the offset inside the block", () => {
    expect(toPosition({ blockId: "b1", offset: 1.3 })).toEqual({ block_id: "b1", offset: 1 });
    expect(toPosition({ blockId: "b1", offset: 0.123456 })).toEqual({ block_id: "b1", offset: 0.1235 });
  });
});

describe("a visit to a passage", () => {
  it("is still a visit near where it landed", () => {
    expect(readOn(1000, 1900, 800)).toBe(false);
    expect(readOn(1000, 200, 800)).toBe(false);
    expect(readOnPages(12, 13)).toBe(false);
  });

  it("becomes reading on once the reader has moved well away", () => {
    expect(readOn(1000, 2700, 800)).toBe(true);
    expect(readOn(3000, 1300, 800)).toBe(true);
    expect(readOnPages(12, 14)).toBe(true);
    expect(readOnPages(12, 9)).toBe(true);
  });
});

describe("extraction issues", () => {
  it("calls the text partial only when something is missing from it", () => {
    expect(isPartial(null)).toBe(false);
    expect(isPartial([])).toBe(false);
    expect(isPartial([{ code: "ocr_pages", count: 2, pages: [1, 2] }])).toBe(false);
    expect(isPartial([{ code: "tables_as_images", count: 1 }])).toBe(true);
    expect(isPartial([{ code: "scanned_pages", count: 0 }])).toBe(false);
  });

  it("lists what is missing before what was read by OCR", () => {
    const issues = shownIssues([
      { code: "ocr_pages", count: 1, pages: [4] },
      { code: "equations_as_images", count: 0 },
      { code: "scanned_pages", count: 2, pages: [2, 3] },
    ]);
    expect(issues.map((i) => i.code)).toEqual(["scanned_pages", "ocr_pages"]);
  });

  it("writes pages as runs", () => {
    expect(pageRuns([3, 2, 4, 9, 7])).toBe("2–4, 7, 9");
    expect(pageRuns([1, 3, 5, 7], 2)).toBe("1, 3, …");
  });
});

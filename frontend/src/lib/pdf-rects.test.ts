import { describe, expect, it } from "vitest";

import { findLoose } from "./find";
import { hitRects, mergeRects } from "./pdf-rects";

describe("mergeRects", () => {
  it("joins boxes on the same line and keeps lines apart", () => {
    const line1 = [
      { x: 0.1, y: 0.2, w: 0.1, h: 0.02 },
      { x: 0.205, y: 0.201, w: 0.1, h: 0.02 },
    ];
    const line2 = [{ x: 0.1, y: 0.23, w: 0.2, h: 0.02 }];
    const merged = mergeRects([...line2, ...line1]);
    expect(merged).toHaveLength(2);
    expect(merged[0].x).toBe(0.1);
    expect(merged[0].w).toBeCloseTo(0.205, 5);
    expect(merged[1]).toEqual(line2[0]);
  });

  it("keeps far-apart boxes on one line separate (two columns)", () => {
    expect(mergeRects([{ x: 0.1, y: 0.2, w: 0.1, h: 0.02 }, { x: 0.6, y: 0.2, w: 0.1, h: 0.02 }])).toHaveLength(2);
  });

  it("drops empty boxes", () => {
    expect(mergeRects([{ x: 0.1, y: 0.2, w: 0, h: 0.02 }])).toEqual([]);
  });
});

describe("hitRects", () => {
  it("finds points inside a rectangle", () => {
    const rects = [{ x: 0.1, y: 0.2, w: 0.3, h: 0.05 }];
    expect(hitRects(rects, 0.2, 0.22)).toBe(true);
    expect(hitRects(rects, 0.5, 0.22)).toBe(false);
  });
});

describe("findLoose", () => {
  it("matches across missing or extra whitespace, ignoring case and diacritics", () => {
    const layer = "Điểm mấu chốtnằm ở chữ tổng quát hóa.";
    const [[s, e]] = findLoose(layer, "mấu chốt\nnằm ở");
    expect(layer.slice(s, e)).toBe("mấu chốtnằm ở");
    expect(findLoose("Học máy", "HOC MAY")).toEqual([[0, 7]]);
    expect(findLoose("abc", "  ")).toEqual([]);
  });
});

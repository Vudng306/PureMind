import { describe, expect, it } from "vitest";

import { CATEGORIES, CATEGORY_FOR_COLOR } from "./annotations";
import { HIGHLIGHT_COLORS } from "./preferences";

describe("CATEGORY_FOR_COLOR", () => {
  it("gives every highlight color a category", () => {
    for (const color of HIGHLIGHT_COLORS) {
      expect(CATEGORIES).toContain(CATEGORY_FOR_COLOR[color]);
    }
  });

  // One colour per category: the reader picks a colour and the AI gets the category, with nothing left over.
  it("uses each category exactly once", () => {
    const used = HIGHLIGHT_COLORS.map((c) => CATEGORY_FOR_COLOR[c]);
    expect(new Set(used).size).toBe(HIGHLIGHT_COLORS.length);
    expect([...used].sort()).toEqual([...CATEGORIES].sort());
  });
});

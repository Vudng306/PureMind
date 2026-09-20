import { describe, expect, it } from "vitest";

import { clearHighlights, normalize, paintHighlights, supportsHighlights } from "./find";

describe("normalize", () => {
  it("strips diacritics and case so 'HOC MAY' finds 'Học máy'", () => {
    expect(normalize("Học máy")).toBe(normalize("HOC MAY"));
    expect(normalize("Đại số")).toBe(normalize("dai so"));
  });
});

// NFR-CMP-01: browsers without the CSS Custom Highlight API must still render the reader — find just
// cannot tint its matches. These run in Node, where `CSS` does not exist, i.e. the unsupported case.
describe("without the CSS Custom Highlight API", () => {
  it("reports the feature as missing instead of throwing", () => {
    expect(supportsHighlights()).toBe(false);
  });

  it("makes painting and clearing no-ops", () => {
    expect(() => paintHighlights([], null)).not.toThrow();
    expect(() => clearHighlights()).not.toThrow();
  });
});

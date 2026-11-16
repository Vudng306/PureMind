import { describe, expect, it } from "vitest";

import { asideBoxes, asideParts, asideText, isHeading, type AsideBlock } from "./aside";

const block = (id: number, type: string, text: string, page = 1): AsideBlock => ({
  id,
  type,
  text,
  page,
  box: [0.1, 0.2, 0.3, 0.04],
  confidence: 0.9,
  reason: "test",
});

describe("aside", () => {
  it("shows a block's words without Markdown or pictures", () => {
    expect(asideText("## 5. References")).toBe("5. References");
    expect(asideText("**Keywords:** biochar")).toBe("Keywords: biochar");
    expect(asideText("![logo](pm-image:abc.webp)")).toBe("");
    expect(isHeading("## References")).toBe(true);
    expect(isHeading("Smith, J. (2020)")).toBe(false);
  });

  it("groups blocks into parts in a fixed order, skipping empty ones", () => {
    const blocks = [
      block(0, "RUNNING_HEADER", "Journal 7"),
      block(1, "REFERENCES", "## References", 9),
      block(2, "REFERENCES", "[1] A. Author", 9),
      block(3, "FUNDING", "Funded by X", 8),
      block(4, "AUTHORS", "Jane Doe"),
      block(5, "PUBLISHER_INFO", "![logo](pm-image:a.webp)"),
    ];
    expect(asideParts(blocks, "supplementary").map((p) => [p.type, p.blocks.map((b) => b.id)])).toEqual([
      ["FUNDING", [3]],
      ["REFERENCES", [1, 2]],
    ]);
    expect(asideParts(blocks, "metadata").map((p) => p.type)).toEqual(["AUTHORS"]);
    expect(asideParts(blocks, "furniture").map((p) => p.type)).toEqual(["RUNNING_HEADER"]);
  });

  it("places a block on its page as the original view does", () => {
    expect(asideBoxes(block(0, "AUTHORS", "x", 3))).toEqual([{ page: 3, x: 0.1, y: 0.2, w: 0.3, h: 0.04 }]);
  });
});

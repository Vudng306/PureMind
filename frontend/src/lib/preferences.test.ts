import { describe, expect, it } from "vitest";

import { colorLabel } from "./preferences";

const unnamed = { yellow: "", green: "", blue: "", pink: "", purple: "" };

describe("colorLabel", () => {
  it("says what an unnamed color means, in the chosen language", () => {
    expect(colorLabel(unnamed, "yellow", "vi")).toBe("Ý chính");
    expect(colorLabel(unnamed, "pink", "en")).toBe("Unclear");
  });

  it("prefers the reader's own name for a color", () => {
    expect(colorLabel({ ...unnamed, blue: " Công thức " }, "blue", "vi")).toBe("Công thức");
  });
});

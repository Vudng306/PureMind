import { describe, expect, it } from "vitest";

import { looksEnglish } from "./translate";

describe("looksEnglish", () => {
  it("takes English words and passages", () => {
    expect(looksEnglish("serendipity")).toBe(true);
    expect(looksEnglish("Machine learning is a branch of AI.")).toBe(true);
    expect(looksEnglish("The study by Đặng and colleagues, run from a café in Hà Nội, was published in 2021.")).toBe(true);
  });

  it("leaves Vietnamese and other languages alone", () => {
    expect(looksEnglish("Học máy là một nhánh của trí tuệ nhân tạo.")).toBe(false);
    expect(looksEnglish("Là où il y a une volonté, il y a un chemin à côté.")).toBe(false);
    expect(looksEnglish("機械学習")).toBe(false);
  });

  it("needs a couple of letters", () => {
    expect(looksEnglish("a")).toBe(false);
    expect(looksEnglish("12.5%")).toBe(false);
    expect(looksEnglish("  — ")).toBe(false);
  });
});

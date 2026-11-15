import { describe, expect, it } from "vitest";

import { looksEnglish, looksVietnamese } from "./translate";

describe("looksEnglish", () => {
  it("takes English words and passages", () => {
    expect(looksEnglish("serendipity")).toBe(true);
    expect(looksEnglish("Machine learning is a branch of AI.")).toBe(true);
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

describe("looksVietnamese", () => {
  it("tells which way a passage is translated, as the server does", () => {
    expect(looksVietnamese("Học máy là một nhánh của trí tuệ nhân tạo.")).toBe(true);
    expect(looksVietnamese("Machine learning is a branch of AI.")).toBe(false);
    expect(looksVietnamese("12.5%")).toBe(false);
  });
});

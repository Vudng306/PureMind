import { describe, expect, it } from "vitest";

import { looksVietnamese } from "./translate";

describe("looksVietnamese", () => {
  it("tells which way a passage is translated, as the server does", () => {
    expect(looksVietnamese("Học máy là một nhánh của trí tuệ nhân tạo.")).toBe(true);
    expect(looksVietnamese("Machine learning is a branch of AI.")).toBe(false);
    expect(looksVietnamese("12.5%")).toBe(false);
  });
});

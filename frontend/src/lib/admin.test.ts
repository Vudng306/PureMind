import { describe, expect, it } from "vitest";

import { formatBytes, pageCount } from "./admin";

describe("formatBytes", () => {
  it("picks the largest unit and keeps one decimal below 100", () => {
    expect(formatBytes(0, "en")).toBe("0 B");
    expect(formatBytes(1536, "en")).toBe("1.5 KB");
    expect(formatBytes(250 * 1024 * 1024, "en")).toBe("250 MB");
    expect(formatBytes(1536, "vi")).toBe("1,5 KB");
  });
});

describe("pageCount", () => {
  it("never reports fewer than one page", () => {
    expect(pageCount(undefined)).toBe(1);
    expect(pageCount({ items: [], total: 0, page: 1, page_size: 25 })).toBe(1);
    expect(pageCount({ items: [], total: 51, page: 1, page_size: 25 })).toBe(3);
  });
});

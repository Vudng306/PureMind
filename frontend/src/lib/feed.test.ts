import { describe, expect, it } from "vitest";

import { readingMinutes } from "./feed";

describe("readingMinutes", () => {
  it("rounds to whole minutes at about 220 words a minute", () => {
    expect(readingMinutes(1100)).toBe(5);
    expect(readingMinutes(1210)).toBe(6);
  });
  it("is never under a minute", () => {
    expect(readingMinutes(0)).toBe(1);
  });
});

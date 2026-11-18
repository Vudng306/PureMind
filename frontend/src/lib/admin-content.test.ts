import { describe, expect, it } from "vitest";

import { niceMax } from "./admin-content";

describe("niceMax", () => {
  it("rounds the tallest bar up to 1, 2 or 5 times a power of ten", () => {
    expect(niceMax([])).toBe(1);
    expect(niceMax([0, 0])).toBe(1);
    expect(niceMax([3])).toBe(5);
    expect(niceMax([7, 2])).toBe(10);
    expect(niceMax([120])).toBe(200);
    expect(niceMax([500])).toBe(500);
    expect(niceMax([5001])).toBe(10000);
    expect(niceMax([1])).toBe(1);
    expect(niceMax([0.037])).toBeCloseTo(0.05);
  });
});

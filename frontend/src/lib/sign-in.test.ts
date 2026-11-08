import { describe, expect, it } from "vitest";

import { safeNext, signInHref } from "./sign-in";

describe("signing in from a page a visitor was on", () => {
  it("comes back to that page", () => {
    expect(signInHref("/feed?short=1")).toBe("/login?next=%2Ffeed%3Fshort%3D1");
    expect(safeNext("/feed/read/abc")).toBe("/feed/read/abc");
  });

  it("goes nowhere off the site", () => {
    expect(safeNext("https://evil.example")).toBeNull();
    expect(safeNext("//evil.example")).toBeNull();
    expect(safeNext("/\\evil.example")).toBeNull();
    expect(safeNext(null)).toBeNull();
  });
});

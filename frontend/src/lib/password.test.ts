import { describe, expect, it } from "vitest";

import { PASSWORD_RE } from "./messages";

describe("PASSWORD_RE", () => {
  it("accepts a password that satisfies the policy", () => {
    expect(PASSWORD_RE.test("PureMind1!")).toBe(true);
  });

  it.each(["puremind1!", "PUREMIND1!", "PureMind!!", "PureMind11", "Ab1! xyz", "Ab1!"])(
    "rejects an incomplete password: %s",
    (password) => {
      expect(PASSWORD_RE.test(password)).toBe(false);
    },
  );
});

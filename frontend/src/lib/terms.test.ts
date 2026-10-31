import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { TERMS, TERMS_VERSION } from "./terms";

describe("terms", () => {
  it("has the version the server asks for", () => {
    const models = readFileSync(resolve(__dirname, "../../../backend/app/models.py"), "utf8");
    expect(models).toContain(`TERMS_VERSION = "${TERMS_VERSION}"`);
  });

  it("says the same in both languages", () => {
    const shape = (lang: "vi" | "en") =>
      TERMS[lang].sections.map((s) => s.body.map((b) => (typeof b === "string" ? "p" : b.length)));
    expect(shape("en")).toEqual(shape("vi"));
  });
});

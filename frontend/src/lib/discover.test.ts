import { describe, expect, it } from "vitest";

import { actionsFor, hostOf, stageOf, type Check } from "./discover";

const check = (status: Check["status"]): Check => ({
  status, kind: status === "importable" ? "article" : "", import_url: "https://a.example/x", title: "", word_count: 0, pdf_url: "", document_id: null,
});
const idle = { check: undefined, checkError: false, adding: false, addError: false, added: null };

describe("a result on Explore", () => {
  it("offers what its state allows, with the original always within reach", () => {
    expect(actionsFor("importable")).toEqual({ primary: "add", more: ["open-source"] });
    expect(actionsFor("blocked")).toEqual({ primary: "open-source", more: ["pdf-guide"] });
    expect(actionsFor("checking")).toEqual({ primary: "wait", more: ["open-source"] });
    expect(actionsFor("check-failed")).toEqual({ primary: "open-source", more: ["recheck", "pdf-guide"] });
    expect(actionsFor("import-failed")).toEqual({ primary: "open-source", more: ["retry-add", "pdf-guide"] });
    expect(actionsFor("ready")).toEqual({ primary: "open-reader", more: ["open-source"] });
    for (const stage of ["importable", "blocked", "checking", "check-failed", "adding", "processing", "import-failed", "ready"] as const) {
      const { primary, more } = actionsFor(stage);
      expect([primary, ...more]).toContain("open-source");
    }
  });

  it("stands where its check and the reader's own steps put it", () => {
    expect(stageOf(idle)).toBe("checking");
    expect(stageOf({ ...idle, check: check("importable") })).toBe("importable");
    expect(stageOf({ ...idle, check: check("blocked") })).toBe("blocked");
    expect(stageOf({ ...idle, check: check("failed") })).toBe("check-failed");
    expect(stageOf({ ...idle, checkError: true })).toBe("check-failed");
    expect(stageOf({ ...idle, check: check("importable"), adding: true })).toBe("adding");
    // The check is only a forecast: adding can fail after it said yes.
    expect(stageOf({ ...idle, check: check("importable"), addError: true })).toBe("import-failed");
    expect(stageOf({ ...idle, added: { extraction_status: "processing", file_type: "pdf" } })).toBe("processing");
    expect(stageOf({ ...idle, added: { extraction_status: "done", file_type: "web" } })).toBe("ready");
    expect(stageOf({ ...idle, added: { extraction_status: "failed", file_type: "web" } })).toBe("import-failed");
    // A PDF with no text to extract is still there to read as it is.
    expect(stageOf({ ...idle, added: { extraction_status: "failed", file_type: "pdf" } })).toBe("ready");
    // A copy already in the library needs no check.
    expect(stageOf({ ...idle, checkError: true, added: { extraction_status: "done", file_type: "web" } })).toBe("ready");
  });

  it("names a site without its www", () => {
    expect(hostOf("https://www.nature.com/articles/x")).toBe("nature.com");
    expect(hostOf("not a url")).toBe("not a url");
  });
});

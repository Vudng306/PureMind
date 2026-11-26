import { describe, expect, it, vi } from "vitest";

import { actionsFor, hostOf, loadHistory, saveHistory, stageOf, withSearch, type Check, type Found } from "./discover";

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

describe("the history of searches on Explore", () => {
  const doc = { url: "https://a.example/x", title: "A", source: "", authors: "", year: null, kind: "article", summary: "", reason: "", document_id: null } as Found;

  it("puts the newest search on top and keeps its answer", () => {
    const first = withSearch([], { query: "giấc ngủ", documents: [doc] }, new Date("2026-11-20T08:00:00Z"));
    const both = withSearch(first, { query: "khí hậu", documents: [] }, new Date("2026-11-21T08:00:00Z"));
    expect(both.map((p) => p.query)).toEqual(["khí hậu", "giấc ngủ"]);
    expect(both[1].documents).toEqual([doc]);
    expect(both[0].at).toBe("2026-11-21T08:00:00.000Z");
    expect(new Set(both.map((p) => p.id)).size).toBe(2);
  });

  it("replaces an older answer to the same subject and stays short", () => {
    let history = withSearch([], { query: "Giấc ngủ", documents: [] });
    history = withSearch(history, { query: "giấc ngủ", documents: [doc] });
    expect(history).toHaveLength(1);
    expect(history[0].documents).toEqual([doc]);
    for (let i = 0; i < 5; i++) history = withSearch(history, { query: `chủ đề ${i}`, documents: [] }, new Date(), 3);
    expect(history.map((p) => p.query)).toEqual(["chủ đề 4", "chủ đề 3", "chủ đề 2"]);
  });

  it("loads only searches saved for the current account", () => {
    const saved = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => saved.get(key) ?? null,
      setItem: (key: string, value: string) => saved.set(key, value),
    });
    vi.stubGlobal("sessionStorage", {
      getItem: () => JSON.stringify({ query: "previous tab search", documents: [doc] }),
      removeItem: vi.fn(),
    });
    try {
      const first = withSearch([], { query: "first account search", documents: [doc] });
      saveHistory("first", first);
      expect(loadHistory("second")).toEqual([]);
      expect(loadHistory("first")).toEqual(first);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

import { describe, expect, it } from "vitest";

import { articleParams, niceMax, runTotals, type CrawlRun } from "./admin-content";

describe("niceMax", () => {
  it("rounds the tallest bar up to 1, 2 or 5 times a power of ten", () => {
    expect(niceMax([])).toBe(1);
    expect(niceMax([0, 0])).toBe(1);
    expect(niceMax([3])).toBe(5);
    expect(niceMax([7, 2])).toBe(10);
    expect(niceMax([120])).toBe(200);
    expect(niceMax([500])).toBe(500);
    expect(niceMax([5001])).toBe(10000);
  });
});

describe("runTotals", () => {
  it("adds every source's counts and leaves the messages out", () => {
    const stat = { fetched: 4, added: 2, updated: 1, duplicates: 1, too_old: 0, blocked: 0, errors: 0, error_messages: [] };
    const run = {
      stats: { plos: stat, elife: { ...stat, added: 3, too_old: 5, errors: 1, error_messages: ["timeout"] } },
    } as unknown as CrawlRun;
    expect(runTotals(run)).toEqual({ fetched: 8, added: 5, updated: 2, duplicates: 2, too_old: 5, blocked: 0, errors: 1 });
  });
});

describe("articleParams", () => {
  it("sends only the filters that are set", () => {
    const params = articleParams({
      q: "  climate ",
      source: "",
      topic: "science",
      kind: "report",
      year: "",
      language: "",
      status: "hidden",
      sort: "oldest",
      page: 2,
    });
    expect(params.toString()).toBe("status=hidden&sort=oldest&page=2&q=climate&topic=science&kind=report");
  });
});

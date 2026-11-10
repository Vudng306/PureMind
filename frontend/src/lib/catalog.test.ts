import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { TOPICS, featuredOf, orderTopics, readNext, startingLevel, type Article } from "./catalog";

const article = (id: string, topic: string): Article => ({
  id, topic, title: id, kind: "research", language: "en", source: "Europe PMC", authors: "",
  url: `https://europepmc.org/articles/${id}`, description: "", license: "CC BY", license_url: "", attribution_url: "",
  content_note: "",
});
const [psych, social, family] = TOPICS.map((topic) => topic.name);

describe("startingLevel", () => {
  const quick = { title: "", problem: "", points: [], conclusion: "", results_complete: true };

  it("starts on the Quick Read only for a Vietnamese reader, and only if there is one", () => {
    expect(startingLevel({ ...article("a", psych), quick }, "vi")).toBe("quick");
    expect(startingLevel({ ...article("a", psych), quick }, "en")).toBe("full");
    expect(startingLevel(article("a", psych), "vi")).toBe("full");
  });
});

describe("orderTopics", () => {
  it("keeps the set order whatever order the API sends, with unknown topics last", () => {
    expect(orderTopics(["Khác", family, psych, social])).toEqual([psych, social, family, "Khác"]);
  });
});

describe("featuredOf", () => {
  const chosen = (id: string, topic: string): Article => ({ ...article(id, topic), headline: `H ${id}`, description: `D ${id}` });

  it("puts the hand-chosen articles first, one a topic, with our headline and the entry's plain words", () => {
    const picks = featuredOf([article("a", social), chosen("b", psych), chosen("c", psych), chosen("d", family)]);
    expect(picks.map((p) => p.article.id)).toEqual(["b", "d", "a"]);
    expect(picks[0]).toMatchObject({ title: "H b", dek: "D b" });
    expect(picks[2].title).toBeUndefined();
  });

  it("finds three chosen entries in three topics in the catalog Explore really has", () => {
    const written = new URL("../../../backend/app/data/catalog.json", import.meta.url);
    const picks = featuredOf(JSON.parse(readFileSync(written, "utf-8")).articles);
    expect(picks).toHaveLength(3);
    expect(picks.every((p) => p.title && p.dek)).toBe(true);
    expect(new Set(picks.map((p) => p.article.topic)).size).toBe(3);
    expect(picks.every((p) => TOPICS.some((topic) => topic.name === p.article.topic))).toBe(true);
  });

  it("fills in from different topics when nothing was chosen", () => {
    const picks = featuredOf([article("a", psych), article("b", psych), article("c", social), article("d", family)]);
    expect(picks.map((p) => p.article.id)).toEqual(["a", "c", "d"]);
  });

  it("copes with a catalog smaller than it wants", () => {
    expect(featuredOf([])).toEqual([]);
    expect(featuredOf([article("a", psych)]).map((p) => p.article.id)).toEqual(["a"]);
  });
});

describe("readNext", () => {
  const articles = [article("a", psych), article("b", psych), article("c", social), article("d", family)];

  it("takes one from each topic before a second from any", () => {
    expect(readNext(articles, []).map((a) => a.id)).toEqual(["a", "c", "d", "b"]);
  });

  it("leaves out what is already shown and stops at the count", () => {
    expect(readNext(articles, [articles[0]], 2).map((a) => a.id)).toEqual(["b", "c"]);
  });
});

import { describe, expect, it } from "vitest";

import { arxivUrl, authorLine, filterPapers, type Paper } from "./papers";

const paper = (over: Partial<Paper>): Paper => ({
  arxiv_id: "1706.03762",
  doi: "10.48550/arxiv.1706.03762",
  title: "Attention Is All You Need",
  authors: ["Ashish Vaswani", "Noam Shazeer", "Niki Parmar", "Jakob Uszkoreit"],
  author_count: 8,
  year: 2017,
  abstract: "The dominant sequence transduction models are based on recurrent networks.",
  category: "cs.CL",
  document_id: null,
  ...over,
});

describe("authorLine", () => {
  it("names the first authors and says there are more", () => {
    expect(authorLine(paper({}))).toBe("Ashish Vaswani, Noam Shazeer, Niki Parmar et al.");
  });
  it("names everyone when there are few", () => {
    expect(authorLine(paper({ authors: ["Peter W. Shor"], author_count: 1 }))).toBe("Peter W. Shor");
  });
});

describe("arxivUrl", () => {
  it("keeps old-style identifiers whole", () => {
    expect(arxivUrl({ arxiv_id: "quant-ph/9508027" })).toBe("https://arxiv.org/abs/quant-ph/9508027");
  });
});

describe("filterPapers", () => {
  const papers = [paper({}), paper({ arxiv_id: "x", title: "Mạng nơ-ron", authors: ["Lê Văn"], abstract: "" })];
  it("matches every word in title, authors or abstract", () => {
    expect(filterPapers(papers, "vaswani recurrent").map((p) => p.arxiv_id)).toEqual(["1706.03762"]);
    expect(filterPapers(papers, "  ")).toHaveLength(2);
  });
  it("ignores accents", () => {
    expect(filterPapers(papers, "mang no-ron le van").map((p) => p.arxiv_id)).toEqual(["x"]);
  });
});

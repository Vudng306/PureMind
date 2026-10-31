import { describe, expect, it } from "vitest";

import { authorsToText, bibFileName, bibtex, bibtexEntry, citeKey, parseDoi, textToAuthors, type BibDoc } from "./citation";
import type { Citation } from "./types";

const citation = (over: Partial<Citation> = {}): Citation => ({
  type: "article",
  authors: [
    { family: "LeCun", given: "Yann" },
    { family: "Bengio", given: "Yoshua" },
  ],
  container: "Nature",
  publisher: "",
  year: 2015,
  volume: "521",
  issue: "7553",
  pages: "436-444",
  doi: "10.1038/nature14539",
  ...over,
});

const doc = (over: Partial<BibDoc> = {}): BibDoc => ({
  title: "Deep learning",
  url: "https://doi.org/10.1038/nature14539",
  citation: citation(),
  created_at: "2026-10-12T03:00:00Z",
  ...over,
});

describe("parseDoi", () => {
  it("reads a DOI however it was pasted", () => {
    for (const raw of [
      "10.1038/nature14539",
      " 10.1038/NATURE14539 ",
      "doi:10.1038/nature14539",
      "DOI: 10.1038/nature14539",
      "https://doi.org/10.1038/nature14539",
      "http://dx.doi.org/10.1038/nature14539.",
    ]) {
      expect(parseDoi(raw)).toBe("10.1038/nature14539");
    }
    expect(parseDoi("https://doi.org/10.1002/(SICI)1097%3A1")).toBe("10.1002/(sici)1097:1");
  });

  it("refuses what is not one", () => {
    for (const raw of ["", "nature14539", "11.1038/x", "10.1038/", "10.1038/a b", "https://example.com/10.1/x"]) {
      expect(parseDoi(raw)).toBeNull();
    }
  });
});

describe("authors as text", () => {
  it("goes one author per line and back", () => {
    const authors = [
      { family: "Nguyễn", given: "Văn A" },
      { family: "Bộ Giáo dục và Đào tạo", given: "" },
    ];
    expect(authorsToText(authors)).toBe("Nguyễn, Văn A\nBộ Giáo dục và Đào tạo");
    expect(textToAuthors("  Nguyễn ,  Văn   A \n\nBộ Giáo dục và Đào tạo\n, Yann\n,")).toEqual([
      ...authors,
      { family: "Yann", given: "" },
    ]);
  });
});

describe("bibtex", () => {
  it("writes a journal article", () => {
    expect(bibtexEntry(doc())).toBe(
      [
        "@article{lecun2015deep,",
        "  author = {LeCun, Yann and Bengio, Yoshua},",
        "  title = {{Deep learning}},",
        "  journal = {Nature},",
        "  year = {2015},",
        "  volume = {521},",
        "  number = {7553},",
        "  pages = {436--444},",
        "  doi = {10.1038/nature14539}",
        "}",
      ].join("\n"),
    );
  });

  it("keeps Vietnamese as it is and escapes what LaTeX would misread", () => {
    const entry = bibtexEntry(
      doc({
        title: "Học máy & 100% dữ_liệu {mở}",
        url: null,
        citation: citation({
          type: "thesis",
          authors: [{ family: "Đại học Quốc gia Hà Nội", given: "" }],
          container: "",
          publisher: "Trường ĐH Công nghệ",
          volume: "",
          issue: "",
          pages: "",
          doi: "",
        }),
      }),
    );
    expect(entry).toContain("@phdthesis{daihocquocgiahanoi2015lieu,");
    expect(entry).toContain("author = {{Đại học Quốc gia Hà Nội}}");
    expect(entry).toContain("title = {{Học máy \\& 100\\% dữ\\_liệu \\{mở\\}}}");
    expect(entry).toContain("school = {Trường ĐH Công nghệ}");
    expect(entry).not.toContain("publisher");
  });

  it("cites a saved page with nothing but its title and link", () => {
    expect(bibtexEntry(doc({ title: "Vì sao cần đọc chậm", url: "https://blog.example.com/a_b", citation: null }))).toBe(
      [
        "@misc{cham,",
        "  title = {{Vì sao cần đọc chậm}},",
        "  url = {https://blog.example.com/a_b},",
        "  note = {Accessed: 2026-10-12}",
        "}",
      ].join("\n"),
    );
    expect(citeKey({ title: "…", url: null, citation: null, created_at: "" })).toBe("doc");
  });

  it("gives every entry of a file its own key", () => {
    const file = bibtex([doc(), doc(), doc({ title: "Deep learning, again" })]);
    expect(file.match(/^@article\{.+,$/gm)).toEqual([
      "@article{lecun2015deep,",
      "@article{lecun2015deep-2,",
      "@article{lecun2015deep-3,",
    ]);
    expect(file.endsWith("}\n")).toBe(true);
  });

  it("names the file by the day", () => {
    expect(bibFileName(new Date(2026, 9, 2))).toBe("puremind-2026-10-02.bib");
  });
});

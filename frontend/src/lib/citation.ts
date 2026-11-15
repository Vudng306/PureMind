import type { Citation, CitationAuthor, CitationType, DocumentListItem } from "./types";

export const CITATION_TYPES: CitationType[] = ["article", "book", "chapter", "conference", "thesis", "report", "misc"];

export const EMPTY_CITATION: Citation = {
  type: "article",
  authors: [],
  container: "",
  publisher: "",
  year: null,
  volume: "",
  issue: "",
  pages: "",
  doi: "",
};

/** One author per line, "Family, Given"; a line without a comma is a name kept whole (an organisation). */
export function authorsToText(authors: CitationAuthor[]): string {
  return authors.map((a) => (a.given ? `${a.family}, ${a.given}` : a.family)).join("\n");
}

export function textToAuthors(text: string): CitationAuthor[] {
  return text
    .split("\n")
    .map((line) => line.trim().replace(/\s+/g, " "))
    .filter(Boolean)
    .map((line) => {
      const comma = line.indexOf(",");
      if (comma < 0) return { family: line, given: "" };
      const family = line.slice(0, comma).trim();
      const given = line.slice(comma + 1).trim();
      return family ? { family, given } : { family: given, given: "" };
    })
    .filter((a) => a.family)
    .slice(0, 100);
}

// ---------------------------------------------------------------- BibTeX

const ENTRY: Record<CitationType, string> = {
  article: "article",
  book: "book",
  chapter: "incollection",
  conference: "inproceedings",
  thesis: "phdthesis",
  report: "techreport",
  misc: "misc",
};
/** What BibTeX calls the journal, the book or the institution a work of each kind appeared in. */
const CONTAINER_FIELD: Record<CitationType, string> = {
  article: "journal",
  book: "series",
  chapter: "booktitle",
  conference: "booktitle",
  thesis: "school",
  report: "institution",
  misc: "howpublished",
};
const TEX: Record<string, string> = {
  "\\": "\\textbackslash{}",
  "{": "\\{",
  "}": "\\}",
  "%": "\\%",
  "&": "\\&",
  $: "\\$",
  "#": "\\#",
  _: "\\_",
  "~": "\\textasciitilde{}",
  "^": "\\textasciicircum{}",
};

/** Text as LaTeX reads it. Accented letters stay as they are: BibTeX files are UTF-8 nowadays. */
const tex = (s: string) => s.replace(/[\\{}%&$#_~^]/g, (c) => TEX[c]);
/** A link is not typeset, only kept from closing the field early. */
const verbatim = (s: string) => s.replace(/[{}]/g, "");

const ascii = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[đĐ]/g, "d")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

export type BibDoc = Pick<DocumentListItem, "title" | "url" | "citation" | "created_at">;

/** "lecun2015deep": first author, year, first telling word of the title. */
export function citeKey(doc: BibDoc): string {
  const author = ascii(doc.citation?.authors[0]?.family ?? "").replace(/ /g, "").slice(0, 20);
  const words = ascii(doc.title).split(" ").filter(Boolean);
  const word = (words.find((w) => w.length > 3) ?? words[0] ?? "").slice(0, 20);
  return `${author}${doc.citation?.year ?? ""}${word}` || "doc";
}

function author(a: CitationAuthor): string {
  // Braces keep a name without a given part (an organisation) from being split into first and last.
  return a.given ? `${tex(a.family)}, ${tex(a.given)}` : `{${tex(a.family)}}`;
}

export function bibtexEntry(doc: BibDoc, key = citeKey(doc)): string {
  const c = doc.citation;
  const type = c?.type ?? "misc";
  const fields: [string, string][] = [];
  if (c?.authors.length) fields.push(["author", c.authors.map(author).join(" and ")]);
  // Doubled braces: BibTeX styles lower-case titles otherwise, which ruins names and Vietnamese titles.
  fields.push(["title", `{${tex(doc.title)}}`]);
  if (c) {
    // A thesis needs a school and a report an institution; with only a publisher given, that is it.
    const standsIn = (type === "thesis" || type === "report") && !c.container;
    const container = standsIn ? c.publisher : c.container;
    if (container) fields.push([CONTAINER_FIELD[type], tex(container)]);
    if (c.publisher && !standsIn) fields.push(["publisher", tex(c.publisher)]);
    if (c.year) fields.push(["year", String(c.year)]);
    if (c.volume) fields.push(["volume", tex(c.volume)]);
    if (c.issue) fields.push(["number", tex(c.issue)]);
    if (c.pages) fields.push(["pages", tex(c.pages.replace(/\s*[-–—]+\s*/g, "--"))]);
  }
  if (doc.url) {
    fields.push(["url", verbatim(doc.url)]);
    // A web page has no year of its own to cite: the day it was saved is the day it was read.
    if (!c?.year) fields.push(["note", `Accessed: ${doc.created_at.slice(0, 10)}`]);
  }
  return `@${ENTRY[type]}{${key},\n${fields.map(([name, value]) => `  ${name} = {${value}}`).join(",\n")}\n}`;
}

/** A .bib file of the documents, each under a key of its own. */
export function bibtex(docs: BibDoc[]): string {
  const seen = new Map<string, number>();
  const entries = docs.map((doc) => {
    const base = citeKey(doc);
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return bibtexEntry(doc, n > 1 ? `${base}-${n}` : base);
  });
  return entries.join("\n\n") + "\n";
}

export function bibFileName(now: Date = new Date()): string {
  const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  return `puremind-${day}.bib`;
}

export const BIBTEX_MIME = "application/x-bibtex;charset=utf-8";

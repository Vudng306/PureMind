/** Explore: the AI chooses a few documents on a subject, and each is checked for whether it can be brought
 * into the library. Nothing is saved until the reader adds a document. */

import { api } from "./api";
import type { Lang } from "./types";

export const MIN_QUERY = 3;
export const MAX_QUERY = 500;

export type Kind = "article" | "report" | "paper" | "book" | "other";
export type SourceAccess = "FULLTEXT_AVAILABLE" | "PARTIAL_CONTENT" | "METADATA_ONLY" | "ACCESS_RESTRICTED" | "UNAVAILABLE";

/** A document the AI chose. The address and the title are the web search's own; `document_id` is the reader's
 * copy, when the address is in their library already. */
export type Found = {
  url: string;
  title: string;
  source: string;
  authors: string;
  year: number | null;
  kind: Kind;
  summary: string;
  reason: string;
  document_id: string | null;
  access?: SourceAccess;
};

export type SearchResult = {
  documents: Found[];
  chat_quota_remaining: number;
  intent: "DISCOVERY" | "DIRECT_QUERY" | "AMBIGUOUS";
  guidance: string;
};

/** What one visit to the address says: a forecast, so adding the document can still fail afterwards. */
export type Check = {
  status: "importable" | "blocked" | "failed";
  kind: "" | "article" | "pdf";
  /** What to save: the address itself, or the PDF its page names. */
  import_url: string;
  title: string;
  word_count: number;
  /** A PDF the page itself names, when its text could not be read from here. */
  pdf_url: string;
  document_id: string | null;
};

export function searchExplore(query: string, language: Lang) {
  return api<SearchResult>("/explore/search", { method: "POST", body: JSON.stringify({ query, language }) });
}

export function checkUrl(url: string) {
  return api<Check>("/explore/check", { method: "POST", body: JSON.stringify({ url }) });
}

/** Where a result stands, from its check and from what the reader has done with it. */
export type Stage =
  | "checking" // the check has not answered yet
  | "importable" // can be added to the library
  | "blocked" // the site does not let its text be read
  | "check-failed" // the check itself could not be made
  | "adding" // being fetched into the library
  | "processing" // in the library, its text still being extracted
  | "import-failed" // adding it failed, whatever the check had said
  | "ready"; // in the library, to be read

export type Action = "add" | "open-reader" | "open-source" | "wait" | "pdf-guide" | "recheck" | "retry-add";

/** The main button of a result and what else it offers, by where it stands. A result that cannot be read from
 * here always keeps its way to the original; one that can, keeps it as the second choice. */
export function actionsFor(stage: Stage): { primary: Action; more: Action[] } {
  switch (stage) {
    case "importable":
      return { primary: "add", more: ["open-source"] };
    case "blocked":
      return { primary: "open-source", more: ["pdf-guide"] };
    case "checking":
    case "adding":
    case "processing":
      return { primary: "wait", more: ["open-source"] };
    case "check-failed":
      return { primary: "open-source", more: ["recheck", "pdf-guide"] };
    case "import-failed":
      return { primary: "open-source", more: ["retry-add", "pdf-guide"] };
    case "ready":
      return { primary: "open-reader", more: ["open-source"] };
  }
}

/** The stage of a result. `added` is the document made by adding it here, or its copy already in the library. */
export function stageOf(state: {
  check: Check | undefined;
  checkError: boolean;
  adding: boolean;
  addError: boolean;
  added: { extraction_status: string; file_type: string } | null;
}): Stage {
  if (state.adding) return "adding";
  if (state.added) {
    const status = state.added.extraction_status;
    if (status === "pending" || status === "processing") return "processing";
    // A PDF whose text could not be extracted is still kept, and read as the original.
    if (status === "failed" && state.added.file_type !== "pdf") return "import-failed";
    return "ready";
  }
  if (state.addError) return "import-failed";
  if (state.checkError) return "check-failed";
  if (!state.check) return "checking";
  if (state.check.status === "importable") return "importable";
  return state.check.status === "blocked" ? "blocked" : "check-failed";
}

/** The site of an address, as a reader would name it. */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** One search as it was answered: the subject and the documents the AI chose. */
export type Kept = { query: string; documents: Found[]; intent?: SearchResult["intent"]; guidance?: string };

/** A past search the reader can open again. Explore itself always opens on an empty page; earlier searches are
 * kept here, in this browser, for each account apart. */
export type Past = Kept & { id: string; at: string };

export const HISTORY_MAX = 20;
const HISTORY = "pm.explore-history.v1";

const historyKey = (userId: string) => `${HISTORY}:${userId}`;

function isPast(x: unknown): x is Past {
  const p = x as Past;
  return Boolean(p) && typeof p.id === "string" && typeof p.at === "string" && typeof p.query === "string" && Array.isArray(p.documents);
}

/** The history with a new search on top. The same subject asked again replaces its older answer. */
export function withSearch(history: Past[], kept: Kept, now: Date = new Date(), max = HISTORY_MAX): Past[] {
  const entry: Past = { ...kept, id: `${now.getTime().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, at: now.toISOString() };
  const same = kept.query.toLocaleLowerCase();
  return [entry, ...history.filter((p) => p.query.toLocaleLowerCase() !== same)].slice(0, max);
}

export function loadHistory(userId: string): Past[] {
  try {
    const raw = JSON.parse(localStorage.getItem(historyKey(userId)) ?? "[]");
    return Array.isArray(raw) ? raw.filter(isPast) : [];
  } catch {
    return [];
  }
}

export function saveHistory(userId: string, history: Past[]) {
  try {
    if (history.length) localStorage.setItem(historyKey(userId), JSON.stringify(history));
    else localStorage.removeItem(historyKey(userId));
  } catch {
    // private mode or storage full: the history just does not outlive the page
  }
}

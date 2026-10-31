"use client";

import { useQuery } from "@tanstack/react-query";

import { API_URL, ApiError, api } from "./api";
import { MSG } from "./messages";
import { usePreferences } from "./preferences";

/** A research paper on arXiv; `document_id` is the user's copy, once it is in their library. */
export type Paper = {
  arxiv_id: string;
  doi: string;
  title: string;
  authors: string[];
  author_count: number;
  year: number | null;
  abstract: string;
  category: string;
  document_id: string | null;
};

export type PaperCollection = { id: CollectionId; papers: Paper[] };
export type PaperSearch = { papers: Paper[]; total: number; page: number; has_more: boolean };

export const COLLECTIONS = ["foundations", "language", "vision", "reinforcement", "physics", "data"] as const;
export type CollectionId = (typeof COLLECTIONS)[number];

/** The fields a search can be narrowed to (arXiv's own category codes), as the API accepts them. */
export const CATEGORIES = ["cs.AI", "cs.LG", "cs.CL", "cs.CV", "cs.RO", "cs.CR", "stat.ML", "quant-ph", "econ.EM", "q-bio.NC"] as const;
export type Category = (typeof CATEGORIES)[number];

export const papersKey = ["papers"] as const;

/** The collections: public, so a visitor gets them without a token; a user also learns which are theirs. */
export function usePaperCollections(signedIn: boolean) {
  return useQuery({
    queryKey: [...papersKey, "collections", signedIn],
    queryFn: async () => {
      if (signedIn) return api<PaperCollection[]>("/papers");
      const res = await fetch(`${API_URL}/api/papers`, {
        headers: { "Accept-Language": usePreferences.getState().language },
      });
      if (!res.ok) throw new ApiError(res.status, MSG["MSG-99"]);
      return (await res.json()) as PaperCollection[];
    },
    staleTime: 5 * 60_000,
  });
}

/** Papers on arXiv for the words of `query`; nothing is asked while the query is blank. */
export function usePaperSearch(query: string, category: Category | "", page: number) {
  const q = query.trim();
  return useQuery({
    queryKey: [...papersKey, "search", q.toLowerCase(), category, page],
    queryFn: () => {
      const params = new URLSearchParams({ q, page: String(page) });
      if (category) params.set("category", category);
      return api<PaperSearch>(`/papers/search?${params}`);
    },
    enabled: q.length > 0,
    staleTime: 10 * 60_000,
    retry: false,
  });
}

/** "Vaswani, Shazeer, Parmar et al." — the first authors, and how many more there are. */
export function authorLine(paper: Pick<Paper, "authors" | "author_count">, shown = 3): string {
  const names = paper.authors.slice(0, shown).join(", ");
  return paper.author_count > shown ? `${names} et al.` : names;
}

export const arxivUrl = (paper: Pick<Paper, "arxiv_id">) => `https://arxiv.org/abs/${paper.arxiv_id}`;

/** The papers whose title, authors or abstract contain every word of `filter`, ignoring case and accents. */
export function filterPapers(papers: Paper[], filter: string): Paper[] {
  const fold = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
  const words = fold(filter).split(/\s+/).filter(Boolean);
  if (!words.length) return papers;
  return papers.filter((p) => {
    const text = fold(`${p.title} ${p.authors.join(" ")} ${p.abstract}`);
    return words.every((w) => text.includes(w));
  });
}

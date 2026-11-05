"use client";

import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { ApiError, api, apiFetch } from "./api";
import { documentsKey } from "./documents";
import { useT } from "./i18n";
import { MSG } from "./messages";
import { readEvents } from "./notebooks";
import type { DocumentDetail, Lang } from "./types";
import { useUi } from "./ui-store";

/** The feed's topics, as the API names them (models.TOPICS). */
export const TOPICS = [
  "science",
  "technology",
  "health",
  "mind",
  "philosophy",
  "environment",
  "economy",
  "law",
  "society",
  "education",
  "family",
  "history",
  "culture",
  "arts",
  "travel",
  "sports",
] as const;
export type Topic = (typeof TOPICS)[number];

/** What an article is, in the order the feed lists them. "guide": a Vietnamese piece the AI wrote from
 * `based_on`, an openly licensed article in the feed. */
export const KINDS = ["explainer", "research", "report", "book", "essay", "guide"] as const;
export type ArticleKind = (typeof KINDS)[number];

/** An openly licensed article; `document_id` is the user's copy, once they have opened it. */
export type ArticleCard = {
  id: string;
  source: string;
  source_name: string;
  url: string;
  title: string;
  authors: string;
  summary: string;
  language: string;
  kind: ArticleKind;
  license: string;
  topics: Topic[];
  tags: string[];
  word_count: number;
  image_url: string | null;
  published_at: string | null;
  based_on: { title: string; source_name: string; url: string } | null;
  document_id: string | null;
};

export type FeedPage = { articles: ArticleCard[]; total: number; has_more: boolean; following: Topic[] | null };
/** What the feed can be narrowed by: the kinds with their articles, and the most used tags. */
export type Facets = { kinds: { id: ArticleKind; count: number }[]; tags: { tag: string; count: number }[] };
export type Topics = { topics: { id: Topic; count: number }[]; following: Topic[] | null };

/** What a short says, in one language. */
export type ShortText = { title: string; hook: string; points: string[]; takeaway: string };

/** A one-minute post the AI wrote from an openly licensed article; "read on" opens `read_id`, the guide
 * written from that article when there is one, else the article itself. `card_index` and `completed` are the
 * user's place in its cards; `en` the same cards in English, once someone has asked for them. */
export type ShortCard = {
  id: string;
  title: string;
  hook: string;
  points: string[];
  takeaway: string;
  topics: Topic[];
  source_name: string;
  original_title: string;
  original_url: string;
  license: string;
  license_url: string;
  read_id: string;
  read_kind: ArticleKind;
  read_words: number;
  document_id: string | null;
  total_cards: number;
  card_index: number;
  completed: boolean;
  en: ShortText | null;
};

export type ShortsPage = { shorts: ShortCard[]; total: number; has_more: boolean };

export const feedKey = ["feed"] as const;
const PAGE = 20;

/** The articles of `topic`, or of every topic the user follows when it is null, narrowed to a kind and a tag
 * when given; page by page. */
export function useFeed(topic: Topic | null, kind: ArticleKind | null = null, tag: string | null = null) {
  return useInfiniteQuery({
    queryKey: [...feedKey, "list", topic, kind, tag],
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({ offset: String(pageParam), limit: String(PAGE) });
      if (topic) params.set("topic", topic);
      if (kind) params.set("kind", kind);
      if (tag) params.set("tag", tag);
      return api<FeedPage>(`/feed?${params}`);
    },
    initialPageParam: 0,
    getNextPageParam: (last, pages) => (last.has_more ? pages.reduce((n, p) => n + p.articles.length, 0) : undefined),
    staleTime: 5 * 60_000,
  });
}

/** The kinds of article in `topic`, and the tags most used among them (or among those of `kind`). */
export function useFacets(topic: Topic | null, kind: ArticleKind | null) {
  return useQuery({
    queryKey: [...feedKey, "facets", topic, kind],
    queryFn: () => {
      const params = new URLSearchParams();
      if (topic) params.set("topic", topic);
      if (kind) params.set("kind", kind);
      return api<Facets>(`/feed/facets?${params}`);
    },
    staleTime: 5 * 60_000,
  });
}

/** The short posts of `topic`, or of every topic the user follows when it is null; "for_you" goes on past those
 * into the other topics. Page by page. */
export function useShorts(topic: Topic | null, mode: "following" | "for_you" = "following") {
  return useInfiniteQuery({
    queryKey: [...feedKey, "list", "shorts", topic, mode],
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({ offset: String(pageParam), limit: String(PAGE), mode });
      if (topic) params.set("topic", topic);
      return api<ShortsPage>(`/feed/shorts?${params}`);
    },
    initialPageParam: 0,
    getNextPageParam: (last, pages) => (last.has_more ? pages.reduce((n, p) => n + p.shorts.length, 0) : undefined),
    staleTime: 5 * 60_000,
  });
}

/** One short, wherever it stands in the list: a shared link or "keep reading" may lead past what is loaded. */
export function useShort(id: string | null) {
  return useQuery({
    queryKey: [...feedKey, "list", "short", id],
    queryFn: () => api<ShortCard>(`/feed/shorts/${id}`),
    enabled: id !== null,
    retry: false,
    staleTime: 5 * 60_000,
  });
}

export const readingKey = [...feedKey, "reading"] as const;

/** The shorts the user left partway through. */
export function useReadingShorts() {
  return useQuery({ queryKey: readingKey, queryFn: () => api<ShortCard[]>("/feed/shorts/reading"), staleTime: 60_000 });
}

export function saveShortProgress(id: string, cardIndex: number) {
  return api<{ card_index: number; completed: boolean }>(`/feed/shorts/${id}/progress`, {
    method: "PUT",
    body: JSON.stringify({ card_index: cardIndex }),
  });
}

export function setShortInterest(id: string, interested: boolean) {
  return api<void>(`/feed/shorts/${id}/interest`, { method: "PUT", body: JSON.stringify({ interested }) });
}

/** The short in English: written on the first request and kept for everyone after. */
export function translateShort(id: string) {
  return api<ShortText>(`/feed/shorts/${id}/translation`, { method: "POST" });
}

/** One card of a short. Its number of cards follows what it says: nothing here assumes how many. */
export type Card =
  | { role: "hook"; title: string; body: string }
  | { role: "insight"; point: number; body: string }
  | { role: "takeaway"; point?: undefined; body: string };

/** The short as cards: the question with its opening, one idea on each, and the thing to keep. */
export function shortCards(text: ShortText): Card[] {
  return [
    { role: "hook", title: text.title, body: text.hook },
    ...text.points.map((body, i): Card => ({ role: "insight", point: i + 1, body })),
    { role: "takeaway", body: text.takeaway },
  ];
}

/** Minutes the cards take, never under one. */
export function shortMinutes(text: ShortText): number {
  const words = [text.title, text.hook, ...text.points, text.takeaway].join(" ").split(/\s+/).length;
  return Math.max(1, Math.round(words / 200));
}

/** The card to open a short on: where the reader stopped, or the start of one they finished. */
export function resumeAt(short: Pick<ShortCard, "card_index" | "completed" | "total_cards">): number {
  if (short.completed) return 0;
  return Math.min(Math.max(short.card_index, 0), short.total_cards - 1);
}

export function useTopics() {
  return useQuery({ queryKey: [...feedKey, "topics"], queryFn: () => api<Topics>("/feed/topics"), staleTime: 5 * 60_000 });
}

export function useFollowTopics() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (topics: Topic[]) => api<Topics>("/feed/topics", { method: "PUT", body: JSON.stringify({ topics }) }),
    onSuccess: (data) => {
      qc.setQueryData([...feedKey, "topics"], data);
      void qc.invalidateQueries({ queryKey: [...feedKey, "list"] });
    },
  });
}

/** The user's copy of the article, made on first reading; then it opens in the reader like any document. */
export function useOpenArticle() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<DocumentDetail>(`/feed/${id}/open`, { method: "POST" }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: documentsKey });
      void qc.invalidateQueries({ queryKey: [...feedKey, "list"] });
    },
  });
}

/** Minutes to read `words` at an unhurried pace, never under one. */
export function readingMinutes(words: number): number {
  return Math.max(1, Math.round(words / 220));
}

/** Opens `id` in the reader, making the user's copy first when there is none (`documentId`). */
export function useRead(id: string, documentId: string | null) {
  const router = useRouter();
  const open = useOpenArticle();
  const [error, setError] = useState<string | null>(null);
  const href = documentId ? `/reader/${documentId}` : null;

  /** `query`: what the reader should open with, as `?panel=chat`. */
  async function read(query = "") {
    if (href) return router.push(`${href}${query}`);
    setError(null);
    try {
      const doc = await open.mutateAsync(id);
      router.push(`/reader/${doc.id}${query}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : MSG["MSG-99"]);
    }
  }

  return { read, opened: href !== null, pending: open.isPending, error };
}

/** Puts `id` in the library, unread, without leaving the feed (`documentId`: it is there already). */
export function useSave(id: string, documentId: string | null) {
  const t = useT();
  const open = useOpenArticle();
  const { showToast } = useUi();

  async function save() {
    if (documentId || open.isPending) return;
    try {
      await open.mutateAsync(id);
      showToast(t("feed.saved"));
    } catch (err) {
      showToast(err instanceof Error ? err.message : MSG["MSG-99"]);
    }
  }

  return { save, saved: documentId !== null || open.isSuccess, saving: open.isPending };
}

/** One turn of the feed's chat, as the page keeps it and sends it back. */
export type ExploreTurn = { role: "user" | "assistant"; content: string };

/** The chat's answer: `articles` were given to the AI numbered from 1, `cited` are the ones it recommended. */
export type ExploreAnswer = {
  content: string;
  articles: ArticleCard[];
  cited: number[];
  chat_quota_remaining: number;
};

/** Earlier turns sent along with a message; the API keeps fewer still in the prompt. */
export const EXPLORE_HISTORY = 12;

/**
 * Talks about what to learn: `onArticles` gets the feed's articles found for the message, `onDelta` the answer
 * as it is written. Throws ApiError when it fails — the message then costs nothing.
 */
export async function exploreChat(
  input: { content: string; history: ExploreTurn[]; language: Lang },
  handlers: { onArticles?: (articles: ArticleCard[]) => void; onDelta: (text: string) => void },
  signal?: AbortSignal,
): Promise<ExploreAnswer> {
  const res = await apiFetch("/feed/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
    body: JSON.stringify({ ...input, history: input.history.slice(-EXPLORE_HISTORY) }),
    signal,
  });
  if (!res.body) throw new ApiError(0, MSG["MSG-99"]);
  try {
    for await (const { event, data } of readEvents(res.body)) {
      const payload = JSON.parse(data);
      if (event === "delta") handlers.onDelta(payload.text);
      else if (event === "sources") handlers.onArticles?.(payload.articles as ArticleCard[]);
      else if (event === "done") return payload as ExploreAnswer;
      else if (event === "error") throw new ApiError(502, payload.detail ?? MSG["MSG-26"]);
    }
  } catch (e) {
    if (e instanceof ApiError || signal?.aborted) throw e;
    throw new ApiError(0, MSG["MSG-26"]); // connection dropped mid-stream
  }
  throw new ApiError(0, MSG["MSG-26"]);
}

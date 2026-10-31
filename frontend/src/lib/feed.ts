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

/** "guide": a Vietnamese piece the AI wrote from `based_on`, an openly licensed article in the feed. */
export type ArticleKind = "explainer" | "research" | "data" | "guide";

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
  word_count: number;
  image_url: string | null;
  published_at: string | null;
  based_on: { title: string; source_name: string; url: string } | null;
  document_id: string | null;
};

export type FeedPage = { articles: ArticleCard[]; total: number; has_more: boolean; following: Topic[] | null };
export type Topics = { topics: { id: Topic; count: number }[]; following: Topic[] | null };

/** A one-minute post the AI wrote from an openly licensed article; "read on" opens `read_id`, the guide
 * written from that article when there is one, else the article itself. */
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
};

export type ShortsPage = { shorts: ShortCard[]; total: number; has_more: boolean };

export const feedKey = ["feed"] as const;
const PAGE = 20;

/** The articles of `topic`, or of every topic the user follows when it is null; page by page. */
export function useFeed(topic: Topic | null) {
  return useInfiniteQuery({
    queryKey: [...feedKey, "list", topic],
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({ offset: String(pageParam), limit: String(PAGE) });
      if (topic) params.set("topic", topic);
      return api<FeedPage>(`/feed?${params}`);
    },
    initialPageParam: 0,
    getNextPageParam: (last, pages) => (last.has_more ? pages.reduce((n, p) => n + p.articles.length, 0) : undefined),
    staleTime: 5 * 60_000,
  });
}

/** The short posts of `topic`, or of every topic the user follows when it is null; page by page. */
export function useShorts(topic: Topic | null) {
  return useInfiniteQuery({
    queryKey: [...feedKey, "list", "shorts", topic],
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({ offset: String(pageParam), limit: String(PAGE) });
      if (topic) params.set("topic", topic);
      return api<ShortsPage>(`/feed/shorts?${params}`);
    },
    initialPageParam: 0,
    getNextPageParam: (last, pages) => (last.has_more ? pages.reduce((n, p) => n + p.shorts.length, 0) : undefined),
    staleTime: 5 * 60_000,
  });
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

  async function read() {
    if (href) return router.push(href);
    setError(null);
    try {
      const doc = await open.mutateAsync(id);
      router.push(`/reader/${doc.id}`);
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

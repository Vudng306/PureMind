"use client";

/**
 * Admin page, beyond accounts: the traffic (counts per day and part of the app), the feed's articles and the
 * crawler that brings them from the open sources. Every change is in the audit log.
 */

import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type { Page } from "./admin";
import { api } from "./api";
import type { Topic } from "./feed";

const key = ["admin"] as const;

// --- Traffic ---------------------------------------------------------------------------------------

export type TrafficRange = 7 | 30 | 90;

export interface TrafficDay {
  day: string;
  requests: number;
  errors: number;
  ai_calls: number;
  active_users: number;
  signups: number;
}

export interface TrafficArea {
  area: string;
  requests: number;
  errors: number;
  ai_calls: number;
}

export interface Traffic {
  days: TrafficDay[];
  areas: TrafficArea[];
  totals: {
    users: number;
    active_today: number;
    signups: number;
    requests: number;
    errors: number;
    ai_calls: number;
    articles: number;
    hidden_articles: number;
    documents: number;
  };
}

export function useTraffic(days: TrafficRange) {
  return useQuery({
    queryKey: [...key, "traffic", days],
    queryFn: () => api<Traffic>(`/admin/traffic?days=${days}`),
    placeholderData: keepPreviousData,
    refetchInterval: 60_000,
  });
}

/** The API's parts, as the traffic names them, and the page's words for each. */
export const AREAS = [
  "documents",
  "highlights",
  "search",
  "summaries",
  "notebooks",
  "chat",
  "translate",
  "feed",
  "catalog",
  "papers",
  "account",
  "admin",
] as const;

// --- Articles --------------------------------------------------------------------------------------

export interface AdminArticle {
  id: string;
  title: string;
  source: string;
  source_name: string;
  url: string;
  kind: string;
  language: string;
  license: string;
  topics: Topic[];
  tags: string[];
  word_count: number;
  published_at: string | null;
  collected_at: string;
  hidden_at: string | null;
  is_guide: boolean;
  has_short: boolean;
}

export interface Facet {
  value: string;
  count: number;
}

export interface AdminArticlePage extends Page<AdminArticle> {
  sources: Facet[];
  years: Facet[];
  languages: Facet[];
  kinds: Facet[];
}

/** How many readers reported one catalog article's Quick Read, by reason. */
export interface QuickReadReports {
  article_id: string;
  title: string;
  url: string;
  quick_title: string;
  wrong: number;
  missing: number;
  other: number;
  last_at: string;
}

export function useQuickReadReports() {
  return useQuery({
    queryKey: [...key, "quick-read-reports"],
    queryFn: () => api<QuickReadReports[]>("/admin/quick-read-reports"),
  });
}

export type ArticleStatus = "all" | "visible" | "hidden";
export type ArticleSort = "newest" | "oldest" | "collected" | "title";

export interface ArticleQuery {
  q: string;
  source: string;
  topic: string;
  kind: string;
  year: string;
  language: string;
  status: ArticleStatus;
  sort: ArticleSort;
  page: number;
}

export function articleParams(query: ArticleQuery): URLSearchParams {
  const params = new URLSearchParams({ status: query.status, sort: query.sort, page: String(query.page) });
  for (const name of ["q", "source", "topic", "kind", "year", "language"] as const) {
    const value = query[name].trim();
    if (value) params.set(name, value);
  }
  return params;
}

export function useAdminArticles(query: ArticleQuery) {
  return useQuery({
    queryKey: [...key, "articles", query],
    queryFn: () => api<AdminArticlePage>(`/admin/articles?${articleParams(query)}`),
    placeholderData: keepPreviousData,
  });
}

function useInvalidateContent() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: [...key, "articles"] });
    void qc.invalidateQueries({ queryKey: [...key, "audit"] });
    void qc.invalidateQueries({ queryKey: [...key, "crawl"] });
    void qc.invalidateQueries({ queryKey: ["feed"] });
  };
}

export function useArticleAction() {
  const done = useInvalidateContent();
  return useMutation({
    mutationFn: ({ id, action }: { id: string; action: "hide" | "show" | "delete" }): Promise<unknown> =>
      action === "delete"
        ? api<void>(`/admin/articles/${id}`, { method: "DELETE" })
        : api<AdminArticle>(`/admin/articles/${id}/${action}`, { method: "POST" }),
    onSuccess: done,
  });
}

export type LinkStatus = "added" | "updated" | "duplicate" | "too_old" | "blocked" | "not_found";

export interface LinkResult {
  status: LinkStatus;
  title: string | null;
  article: AdminArticle | null;
}

export function useAddFromLink() {
  const done = useInvalidateContent();
  return useMutation({
    mutationFn: (body: { url: string; topics: Topic[] }) =>
      api<LinkResult>("/admin/articles/from-link", { method: "POST", body: JSON.stringify(body) }),
    onSuccess: done,
  });
}

// --- Crawler ---------------------------------------------------------------------------------------

export interface Channel {
  id: string;
  key: string;
  topics: Topic[];
  enabled: boolean;
}

export interface CrawlSource {
  id: string;
  name: string;
  enabled: boolean;
  /** What a channel names on this source; null: it is read whole and sorts its own topics. */
  channel: "section" | "subject" | "query" | "set" | "publisher" | null;
  hosts: string[];
  article_count: number;
  channels: Channel[];
}

export interface SourceStats {
  fetched: number;
  added: number;
  updated: number;
  duplicates: number;
  too_old: number;
  blocked: number;
  errors: number;
  error_messages: string[];
}

export interface CrawlRun {
  id: string;
  trigger: "schedule" | "manual" | "link";
  sources: string[];
  status: "running" | "done" | "failed";
  admin_email: string | null;
  stats: Record<string, SourceStats>;
  error: string | null;
  started_at: string;
  finished_at: string | null;
}

export interface Schedule {
  enabled: boolean;
  hour: number;
}

export interface CrawlOverview {
  schedule: Schedule;
  cutoff: string;
  running: CrawlRun | null;
  last_run: CrawlRun | null;
  sources: CrawlSource[];
  topics: Topic[];
}

export function useCrawl() {
  return useQuery({
    queryKey: [...key, "crawl"],
    queryFn: () => api<CrawlOverview>("/admin/crawl"),
    // While a run goes on, its counts come in source by source.
    refetchInterval: (q) => (q.state.data?.running ? 3000 : false),
  });
}

export function useCrawlRuns(page: number, live: boolean) {
  return useQuery({
    queryKey: [...key, "crawl", "runs", page],
    queryFn: () => api<Page<CrawlRun>>(`/admin/crawl/runs?page=${page}`),
    placeholderData: keepPreviousData,
    refetchInterval: live ? 3000 : false,
  });
}

/** Any change to the crawler's settings: the answer is small, so the overview is simply read again. */
export function useCrawlChange<V>(request: (vars: V) => Promise<unknown>) {
  const done = useInvalidateContent();
  return useMutation({ mutationFn: request, onSuccess: done });
}

export const crawlApi = {
  schedule: (s: Schedule) => api<Schedule>("/admin/crawl/schedule", { method: "PUT", body: JSON.stringify(s) }),
  source: ({ id, enabled }: { id: string; enabled: boolean }) =>
    api(`/admin/crawl/sources/${id}`, { method: "PUT", body: JSON.stringify({ enabled }) }),
  addChannel: ({ source, key: k, topics }: { source: string; key: string; topics: Topic[] }) =>
    api<Channel>(`/admin/crawl/sources/${source}/channels`, { method: "POST", body: JSON.stringify({ key: k, topics }) }),
  updateChannel: ({ id, ...change }: { id: string; enabled?: boolean; topics?: Topic[] }) =>
    api<Channel>(`/admin/crawl/channels/${id}`, { method: "PATCH", body: JSON.stringify(change) }),
  deleteChannel: (id: string) => api<void>(`/admin/crawl/channels/${id}`, { method: "DELETE" }),
  run: (sources: string[] | null) => api<CrawlRun>("/admin/crawl/runs", { method: "POST", body: JSON.stringify({ sources }) }),
};

/** A run's counts over all its sources. */
export function runTotals(run: CrawlRun): Omit<SourceStats, "error_messages"> {
  const total = { fetched: 0, added: 0, updated: 0, duplicates: 0, too_old: 0, blocked: 0, errors: 0 };
  for (const s of Object.values(run.stats)) {
    for (const name of Object.keys(total) as (keyof typeof total)[]) total[name] += s[name] ?? 0;
  }
  return total;
}

/** The tallest bar's value, rounded up to a figure an axis can show (1, 2, 5 × 10ⁿ). */
export function niceMax(values: number[]): number {
  const max = Math.max(0, ...values);
  if (max <= 1) return 1;
  const step = 10 ** Math.floor(Math.log10(max));
  return ([1, 2, 5, 10].map((m) => m * step).find((n) => n >= max) ?? max) as number;
}

// --- Published posts --------------------------------------------------------------------------------

export type PostState = "all" | "reported" | "hidden";

export interface AdminPost {
  id: string;
  kind: string;
  title: string;
  cards: { heading: string; body: string }[];
  body: string;
  topic: string | null;
  ai_assisted: boolean;
  author: { name: string };
  sources: { title: string; url: string | null; credit: string; license: string | null }[];
  published_at: string | null;
  hidden: boolean;
  reports: Record<string, number>;
}

export interface AdminComment {
  id: string;
  post_id: string;
  body: string;
  author: { name: string };
  created_at: string;
  hidden: boolean;
  reports: Record<string, number>;
}

const postsKey = [...key, "posts"] as const;

export function useAdminPosts(state: PostState, page: number) {
  return useQuery({
    queryKey: [...postsKey, "list", state, page],
    queryFn: () => api<Page<AdminPost>>(`/admin/posts?state=${state}&page=${page}`),
    placeholderData: keepPreviousData,
  });
}

export function useAdminComments(state: "reported" | "hidden") {
  return useQuery({
    queryKey: [...postsKey, "comments", state],
    queryFn: () => api<AdminComment[]>(`/admin/comments?state=${state}`),
  });
}

function useInvalidatePosts() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: postsKey });
    void qc.invalidateQueries({ queryKey: [...key, "audit"] });
  };
}

export function usePostAction() {
  const done = useInvalidatePosts();
  return useMutation({
    mutationFn: ({ id, action }: { id: string; action: "hide" | "show" | "delete" }): Promise<unknown> =>
      action === "delete"
        ? api<void>(`/admin/posts/${id}`, { method: "DELETE" })
        : api<AdminPost>(`/admin/posts/${id}/${action}`, { method: "POST" }),
    onSuccess: done,
  });
}

export function useCommentAction() {
  const done = useInvalidatePosts();
  return useMutation({
    mutationFn: ({ id, action }: { id: string; action: "hide" | "show" }) =>
      api<AdminComment>(`/admin/comments/${id}/${action}`, { method: "POST" }),
    onSuccess: done,
  });
}

"use client";

/** Admin page: what the AI costs, in tokens and US dollars, overall and request by request. */

import { keepPreviousData, useQuery } from "@tanstack/react-query";

import type { Page } from "./admin";
import type { TrafficRange } from "./admin-content";
import { api } from "./api";
import type { Key, T } from "./i18n";
import type { Lang } from "./types";

export interface Spend {
  calls: number;
  failed_calls: number;
  prompt_tokens: number;
  cached_tokens: number;
  completion_tokens: number;
  web_searches: number;
  cost_usd: number;
  unpriced_calls: number;
}

export interface AiCosts {
  days: (Spend & { day: string })[];
  totals: Spend & { requests: number; today_cost_usd: number };
  features: (Spend & { key: string })[];
  models: (Spend & { key: string })[];
  users: (Spend & { user_id: string; email: string })[];
  prices: {
    checked: string;
    web_search_per_1k: number;
    models: { model: string; input: number; cached: number; output: number }[];
  };
}

export interface AiCall {
  id: string;
  at: string;
  purpose: string;
  model: string;
  prompt_tokens: number;
  cached_tokens: number;
  completion_tokens: number;
  web_searches: number;
  cost_usd: number | null;
  ok: boolean;
  duration_ms: number;
}

export interface AiRequest {
  request_id: string;
  at: string;
  user_id: string | null;
  email: string | null;
  prompt_tokens: number;
  cached_tokens: number;
  completion_tokens: number;
  cost_usd: number;
  unpriced_calls: number;
  calls: AiCall[];
}

export function useAiCosts(days: TrafficRange) {
  return useQuery({
    queryKey: ["admin", "ai-costs", days],
    queryFn: () => api<AiCosts>(`/admin/ai-costs?days=${days}`),
    placeholderData: keepPreviousData,
    refetchInterval: 60_000,
  });
}

export function useAiRequests(days: TrafficRange, page: number) {
  return useQuery({
    queryKey: ["admin", "ai-costs", days, "requests", page],
    queryFn: () => api<Page<AiRequest>>(`/admin/ai-costs/requests?days=${days}&page=${page}`),
    placeholderData: keepPreviousData,
    refetchInterval: 60_000,
  });
}

/** The features the server names, each with its words in `cost.purpose.*`. */
const PURPOSES = [
  "summary",
  "summary_part",
  "notebook",
  "post_draft",
  "chat",
  "chat_index",
  "chat_query",
  "translate",
  "translate_article",
  "translate_short",
  "explore_search",
  "explore_choose",
  "explore_chat",
  "explore_index",
  "explore_query",
  "figure_notes",
  "page_ocr",
  "table_ocr",
  "equation_ocr",
  "guide",
  "short",
  "quick_read",
  "catalog_card",
  "reader_part",
  "reader_quick",
  "reader_deep",
  "reader_mindmap",
  "reader_analysis",
] as const;

export function purposeLabel(purpose: string, t: T): string {
  return (PURPOSES as readonly string[]).includes(purpose) ? t(`cost.purpose.${purpose}` as Key) : purpose;
}

/** Dollars with as many decimals as the amount needs: one question can cost a hundredth of a cent. */
export function formatUsd(value: number, lang: Lang): string {
  const locale = lang === "en" ? "en-US" : "vi-VN";
  const money = (amount: number, digits: number) =>
    amount.toLocaleString(locale, {
      style: "currency",
      currency: "USD",
      currencyDisplay: "narrowSymbol",
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    });
  if (value === 0) return money(0, 2);
  if (value < 0.000001) return `< ${money(0.000001, 6)}`;
  if (value < 0.01) return money(value, 6);
  if (value < 1) return money(value, 4);
  return money(value, 2);
}

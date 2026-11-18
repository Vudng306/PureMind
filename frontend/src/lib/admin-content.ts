"use client";

/** The admin's traffic page: counts per day and part of the app. */

import { keepPreviousData, useQuery } from "@tanstack/react-query";

import { api } from "./api";

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

/** The API's parts, as the traffic names them, and the page's words for each. Days already counted keep the
 * names of parts that have since gone. */
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

/** The tallest bar's value, rounded up to a figure an axis can show (1, 2, 5 × 10ⁿ). */
export function niceMax(values: number[]): number {
  const max = Math.max(0, ...values);
  if (max <= 0) return 1;
  const step = 10 ** Math.floor(Math.log10(max));
  return ([1, 2, 5, 10].map((m) => m * step).find((n) => n >= max) ?? max) as number;
}

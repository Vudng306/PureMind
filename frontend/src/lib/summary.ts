"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { ApiError, api } from "./api";
import { accountKey } from "./queries";
import type { User } from "./types";

/** FR-SUM-01/02: the AI summary of a document. */
export interface Summary {
  document_id: string;
  key_points: string[];
  concepts: { term: string; explanation: string }[];
  conclusion: string;
  keywords: string[];
  language: "vi" | "en";
  ai_model: string;
  created_at: string;
}

export type SummaryLanguage = "auto" | "vi" | "en";

const summaryKey = (docId: string) => ["summary", docId] as const;

/** The saved summary; null when the document has none yet (MSG-33). */
export function useSummary(docId: string) {
  return useQuery({
    queryKey: summaryKey(docId),
    queryFn: async () => {
      try {
        return await api<Summary>(`/documents/${docId}/summary`);
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) return null;
        throw e;
      }
    },
    staleTime: Infinity,
  });
}

/** Creates or replaces the summary. The old one stays on screen until the new one arrives (FR-SUM-02 step 2). */
export function useCreateSummary(docId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (language: SummaryLanguage) =>
      api<Summary>(`/documents/${docId}/summary`, {
        method: "POST",
        body: JSON.stringify(language === "auto" ? {} : { language }),
      }),
    onSuccess: (summary) => {
      qc.setQueryData(summaryKey(docId), summary);
      qc.setQueryData<User>(accountKey, (u) => (u ? { ...u, ai_quota_remaining: Math.max(0, u.ai_quota_remaining - 1) } : u));
    },
    onError: (e) => {
      if (e instanceof ApiError && e.status === 429) void qc.invalidateQueries({ queryKey: accountKey });
    },
  });
}

/** NFR-PRV: the user agrees once before any content is sent to OpenAI (reading_preferences.ai_consent). */
export function useAiConsent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      api<User>("/account", { method: "PATCH", body: JSON.stringify({ reading_preferences: { ai_consent: true } }) }),
    onSuccess: (user) => qc.setQueryData(accountKey, user),
  });
}

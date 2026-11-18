"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";

import { api } from "./api";
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

/** NFR-PRV: the user agrees once before any content is sent to OpenAI (reading_preferences.ai_consent). */
export function useAiConsent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      api<User>("/account", { method: "PATCH", body: JSON.stringify({ reading_preferences: { ai_consent: true } }) }),
    onSuccess: (user) => qc.setQueryData(accountKey, user),
  });
}

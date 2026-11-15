"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { ApiError, api } from "./api";
import type { ChatCitation } from "./chat";
import { accountKey } from "./queries";
import type { User } from "./types";

/** The reader's AI sidebar: a quick summary, a deep summary and a mind map of the document being read.
 * Every point names the passages it rests on (`sources`: positions in `citations`). */

export type ArtifactKind = "quick" | "deep" | "mindmap" | "analysis";
export type AiLanguage = "auto" | "vi" | "en";

export interface Point {
  text: string;
  sources: number[];
}

export interface QuickPayload {
  tldr: string;
  tldr_sources: number[];
  takeaways: Point[];
  citations: ChatCitation[];
}

export const DEEP_SECTIONS = ["context", "core", "findings", "limitations"] as const;
export type DeepSection = (typeof DEEP_SECTIONS)[number];

export interface DeepPayload extends Record<DeepSection, Point[]> {
  document_type: "research" | "report" | "essay" | "book" | "guide" | "other";
  questions: string[];
  citations: ChatCitation[];
}

export interface MapNode {
  id: string;
  parent: string | null;
  label: string;
  detail: string;
  sources: number[];
  depth: number;
}

export interface MindMapPayload {
  nodes: MapNode[];
  citations: ChatCitation[];
}

/** AI-111: what a study or a report itself reports; an empty list is "not reported". No score of any kind. */
export const ANALYSIS_FIELDS = ["question", "method", "data", "findings", "limitations", "applicability"] as const;
export type AnalysisField = (typeof ANALYSIS_FIELDS)[number];
/** The kinds of document a research analysis is for; a deep summary that found another keeps it hidden. */
export const RESEARCH_TYPES: DeepPayload["document_type"][] = ["research", "report"];

export interface AnalysisPayload extends Record<AnalysisField, Point[]> {
  document_type: "research" | "report";
  citations: ChatCitation[];
}

interface Payloads {
  quick: QuickPayload;
  deep: DeepPayload;
  mindmap: MindMapPayload;
  analysis: AnalysisPayload;
}

export interface Artifact<K extends ArtifactKind = ArtifactKind> {
  id: string;
  document_id: string;
  kind: K;
  language: "vi" | "en";
  payload: Payloads[K];
  ai_model: string;
  created_at: string;
  /** Made from another text, prompt or model than it would be now (AI-107). */
  stale: boolean;
  /** Which of them, the text first. */
  stale_reason?: "content" | "prompt" | "model" | null;
  ai_quota_remaining: number;
}

const artifactKey = (docId: string, kind: ArtifactKind) => ["reader-ai", docId, kind] as const;

/** The stored result; null when none has been made yet. Reading it costs nothing. */
export function useArtifact<K extends ArtifactKind>(docId: string, kind: K, enabled = true) {
  return useQuery({
    queryKey: artifactKey(docId, kind),
    queryFn: async () => {
      try {
        return await api<Artifact<K>>(`/documents/${docId}/ai/${kind}`);
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) return null;
        throw e;
      }
    },
    enabled,
    staleTime: 5 * 60_000,
  });
}

/** Makes the result, or makes it again. The one before stays on screen until the new one arrives. */
export function useCreateArtifact<K extends ArtifactKind>(docId: string, kind: K) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (language: AiLanguage) =>
      api<Artifact<K>>(`/documents/${docId}/ai/${kind}`, {
        method: "POST",
        body: JSON.stringify(language === "auto" ? {} : { language }),
      }),
    onSuccess: (artifact) => {
      qc.setQueryData(artifactKey(docId, kind), artifact);
      qc.setQueryData<User>(accountKey, (u) => (u ? { ...u, ai_quota_remaining: artifact.ai_quota_remaining } : u));
    },
    onError: (e) => {
      if (e instanceof ApiError && e.status === 429) void qc.invalidateQueries({ queryKey: accountKey });
    },
  });
}

/** Enough of a passage to find it again in the document (FR-RDR-04 find). */
const FIND_WORDS = 8;

const MIN_FIND_WORDS = 4;

/**
 * The words to search the document for. A passage is stored as Markdown and may run over several blocks,
 * while find looks at the text as it is shown: the marks are dropped, and the words come from one line (the
 * first with enough of them to be found only where the passage is).
 */
export function findSnippet(text: string): string {
  const lines = text
    .split(/\r?\n/)
    .map((line) =>
      line
        .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1") // a link or an image keeps its text
        .replace(/^\s*(#{1,6}|>+|[-+*]|\d+[.)])\s+/, "") // heading, quote and list marks
        .replace(/[*`~]+/g, "") // emphasis and code marks
        .replace(/(^|\s)_+|_+(?=\s|$)/g, "$1")
        .trim()
        .split(/\s+/)
        .filter(Boolean),
    )
    .filter((words) => words.length > 0);
  const line = lines.find((words) => words.length >= MIN_FIND_WORDS) ?? lines[0] ?? [];
  return line.slice(0, FIND_WORDS).join(" ");
}

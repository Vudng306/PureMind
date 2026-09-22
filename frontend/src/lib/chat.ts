"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { ApiError, api, apiFetch } from "./api";
import { translate } from "./i18n";
import { MSG } from "./messages";
import { readEvents } from "./notebooks";
import { accountKey } from "./queries";
import { currentLang } from "./preferences";
import type { Lang, User } from "./types";

/** FR-CHAT-01..03: chat with the document being read. Answers cite the passages they used as [n]. */

export const MAX_CHAT_QUESTION = 2000;

/** One passage of the document: where it is and what it says. */
export interface ChatCitation {
  position: number;
  page_number: number | null;
  heading: string | null;
  text: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  citations: ChatCitation[];
  ai_model: string | null;
  created_at: string;
}

export interface ChatConversation {
  id: string;
  document_id: string;
  title: string;
  language: "vi" | "en";
  messages: ChatMessage[];
  created_at: string;
  updated_at: string;
}

export interface ChatConversationItem {
  id: string;
  title: string;
  language: "vi" | "en";
  message_count: number;
  created_at: string;
  updated_at: string;
}

export interface ChatAnswer {
  question: ChatMessage;
  answer: ChatMessage;
  chat_quota_remaining: number;
}

const chatKey = (docId: string) => ["chat", docId] as const;
const conversationKey = (docId: string, id: string) => [...chatKey(docId), "one", id] as const;

export function useConversations(docId: string, enabled = true) {
  return useQuery({
    queryKey: [...chatKey(docId), "list"],
    queryFn: () => api<ChatConversationItem[]>(`/documents/${docId}/chat/conversations`),
    enabled,
  });
}

export function useConversation(docId: string, id: string | null) {
  return useQuery({
    queryKey: conversationKey(docId, id ?? ""),
    queryFn: () => api<ChatConversation>(`/documents/${docId}/chat/conversations/${id}`),
    enabled: Boolean(id),
  });
}

export function useCreateConversation(docId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<ChatConversation>(`/documents/${docId}/chat/conversations`, { method: "POST" }),
    onSuccess: (conv) => {
      qc.setQueryData(conversationKey(docId, conv.id), conv);
      void qc.invalidateQueries({ queryKey: [...chatKey(docId), "list"] });
    },
  });
}

export function useDeleteConversation(docId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api<void>(`/documents/${docId}/chat/conversations/${id}`, { method: "DELETE" }),
    onSuccess: (_, id) => {
      qc.removeQueries({ queryKey: conversationKey(docId, id) });
      void qc.invalidateQueries({ queryKey: [...chatKey(docId), "list"] });
    },
  });
}

/**
 * FR-CHAT-02: asks one question, calling `onSources` with the passages found and `onDelta` with the answer
 * as it is written. Resolves with both stored turns; throws ApiError when it fails — nothing is stored then.
 */
export async function askQuestion(
  docId: string,
  conversationId: string,
  input: { content: string; quote?: string | null },
  handlers: { onSources?: (sources: ChatCitation[]) => void; onDelta: (text: string) => void },
  signal?: AbortSignal,
): Promise<ChatAnswer> {
  const body: Record<string, unknown> = { content: input.content };
  if (input.quote?.trim()) body.quote = input.quote.trim();

  const res = await apiFetch(`/documents/${docId}/chat/conversations/${conversationId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.body) throw new ApiError(0, MSG["MSG-99"]);
  try {
    for await (const { event, data } of readEvents(res.body)) {
      const payload = JSON.parse(data);
      if (event === "delta") handlers.onDelta(payload.text);
      else if (event === "sources") handlers.onSources?.(payload.sources as ChatCitation[]);
      else if (event === "done") return payload as ChatAnswer;
      else if (event === "error") throw new ApiError(502, payload.detail ?? MSG["MSG-26"]);
    }
  } catch (e) {
    if (e instanceof ApiError || signal?.aborted) throw e;
    throw new ApiError(0, MSG["MSG-26"]); // connection dropped mid-stream
  }
  throw new ApiError(0, MSG["MSG-26"]);
}

/** After an answered question: the thread has two more turns and one question of today is gone. */
export function afterAnswer(
  qc: ReturnType<typeof useQueryClient>,
  docId: string,
  conversationId: string,
  result: ChatAnswer,
) {
  qc.setQueryData<ChatConversation>(conversationKey(docId, conversationId), (conv) =>
    conv
      ? {
          ...conv,
          title: conv.title || result.question.content.slice(0, 80),
          messages: [...conv.messages, result.question, result.answer],
          updated_at: result.answer.created_at,
        }
      : conv,
  );
  qc.setQueryData<User>(accountKey, (u) =>
    u ? { ...u, chat_quota_remaining: result.chat_quota_remaining } : u,
  );
  void qc.invalidateQueries({ queryKey: [...chatKey(docId), "list"] });
}

/** The passages an answer refers to, in the order they are first cited. */
export function citedSources(content: string, citations: ChatCitation[]): ChatCitation[] {
  const byPosition = new Map(citations.map((c) => [c.position, c]));
  const seen: ChatCitation[] = [];
  for (const m of content.matchAll(/\[(\d{1,3})\]/g)) {
    const source = byPosition.get(Number(m[1]));
    if (source && !seen.includes(source)) seen.push(source);
  }
  return seen;
}

/** What a citation is called in the interface: its page, its heading, or just its number. */
export function citationLabel(c: ChatCitation, lang: Lang = currentLang()): string {
  if (c.page_number && c.heading)
    return translate(lang, "chat.citePageHeading", { page: c.page_number, heading: c.heading });
  if (c.page_number) return translate(lang, "chat.citePage", { page: c.page_number });
  return c.heading || translate(lang, "chat.citeBlock", { n: c.position });
}

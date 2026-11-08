"use client";

/** The Publish flow and the community feed. A post is its own text: nothing here makes a document public. */

import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "./api";
import type { Topic } from "./feed";
import { accountKey } from "./queries";
import type { User } from "./types";

export const MIN_POST_CARDS = 3;
export const MAX_POST_CARDS = 9;
export const MAX_POST_TITLE = 160;
export const MAX_CARD_HEADING = 120;
export const MAX_CARD_BODY = 600;
export const MAX_POST_BODY = 20_000;
export const MAX_COMMENT_CHARS = 1000;

export const POST_KINDS = ["summary", "insight", "synthesis", "link"] as const;
export type PostKind = (typeof POST_KINDS)[number];
export const REPORT_REASONS = ["copyright", "inaccurate", "spam", "offensive"] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];

export interface PostCard {
  heading: string;
  body: string;
}

export interface PostSource {
  id: string;
  document_id: string | null;
  title: string;
  url: string | null;
  credit: string;
  license: string | null;
  shown: boolean;
  no_derivatives: boolean;
}

export interface Post {
  id: string;
  kind: PostKind;
  status: "draft" | "published";
  title: string;
  cards: PostCard[];
  body: string;
  topic: Topic | null;
  ai_assisted: boolean;
  notebook_id: string | null;
  sources: PostSource[];
  published_at: string | null;
  hidden: boolean;
  created_at: string;
  updated_at: string;
}

export interface PostIssue {
  code: string;
  level: "error" | "warning";
  message: string;
}

export interface PostCheck {
  issues: PostIssue[];
  can_publish: boolean;
  needs_review: boolean;
}

export type PostPatch = Partial<Pick<Post, "kind" | "title" | "cards" | "body" | "topic">> & {
  shown_source_ids?: string[];
};

export const postsKey = ["posts"] as const;
export const communityKey = ["community"] as const;

export function useMyPosts() {
  return useQuery({ queryKey: [...postsKey, "mine"], queryFn: () => api<Post[]>("/posts") });
}

export function usePost(id: string) {
  return useQuery({
    queryKey: [...postsKey, "one", id],
    queryFn: () => api<Post>(`/posts/${id}`),
    refetchOnWindowFocus: false,
  });
}

export function usePostCheck(id: string) {
  return useQuery({ queryKey: [...postsKey, "check", id], queryFn: () => api<PostCheck>(`/posts/${id}/check`) });
}

/** Starts a private draft from a document or a notebook. */
export function useCreatePost() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { kind?: PostKind; document_id?: string; notebook_id?: string }) =>
      api<Post>("/posts", { method: "POST", body: JSON.stringify(input) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: postsKey }),
  });
}

function useAfterPost(id: string) {
  const qc = useQueryClient();
  return (post: Post) => {
    qc.setQueryData([...postsKey, "one", id], post);
    void qc.invalidateQueries({ queryKey: [...postsKey, "mine"] });
    void qc.invalidateQueries({ queryKey: [...postsKey, "check", id] });
    void qc.invalidateQueries({ queryKey: communityKey });
  };
}

export function useUpdatePost(id: string) {
  const after = useAfterPost(id);
  return useMutation({
    mutationFn: (patch: PostPatch) => api<Post>(`/posts/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
    onSuccess: after,
  });
}

export function usePublishPost(id: string) {
  const after = useAfterPost(id);
  return useMutation({
    mutationFn: (confirm: { confirm_rights: boolean; confirm_reviewed: boolean }) =>
      api<Post>(`/posts/${id}/publish`, { method: "POST", body: JSON.stringify(confirm) }),
    onSuccess: after,
  });
}

export function useUnpublishPost(id: string) {
  const after = useAfterPost(id);
  return useMutation({
    mutationFn: () => api<Post>(`/posts/${id}/unpublish`, { method: "POST" }),
    onSuccess: after,
  });
}

/** One AI request, asked for by the author, for this one post. */
export function useDraftPost(id: string) {
  const after = useAfterPost(id);
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<Post>(`/posts/${id}/draft`, { method: "POST" }),
    onSuccess: (post) => {
      after(post);
      qc.setQueryData<User>(accountKey, (u) =>
        u ? { ...u, ai_quota_remaining: Math.max(0, u.ai_quota_remaining - 1) } : u,
      );
    },
  });
}

export function useDeletePost() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<void>(`/posts/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: postsKey });
      void qc.invalidateQueries({ queryKey: communityKey });
    },
  });
}

// --- Community -------------------------------------------------------------------------------------------

export interface PublicSource {
  title: string;
  url: string | null;
  credit: string;
  license: string | null;
}

export interface PublicPost {
  id: string;
  kind: PostKind;
  title: string;
  cards: PostCard[];
  body: string;
  topic: Topic | null;
  ai_assisted: boolean;
  published_at: string | null;
  author: { name: string };
  sources: PublicSource[];
  saved: boolean;
  mine: boolean;
  comment_count: number;
}

export interface PublicComment {
  id: string;
  body: string;
  author: { name: string };
  mine: boolean;
  created_at: string;
}

const PAGE_SIZE = 20;

export function useCommunity(topic: Topic | null) {
  return useInfiniteQuery({
    queryKey: [...communityKey, "feed", topic],
    initialPageParam: 0,
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({ offset: String(pageParam), limit: String(PAGE_SIZE) });
      if (topic) params.set("topic", topic);
      return api<{ items: PublicPost[]; has_more: boolean }>(`/community?${params}`);
    },
    getNextPageParam: (last, _all, offset) => (last.has_more ? offset + PAGE_SIZE : undefined),
  });
}

export function useSavedPosts(enabled: boolean) {
  return useQuery({
    queryKey: [...communityKey, "saved"],
    queryFn: () => api<PublicPost[]>("/community/saved"),
    enabled,
  });
}

export function useCommunityPost(id: string) {
  return useQuery({ queryKey: [...communityKey, "one", id], queryFn: () => api<PublicPost>(`/community/${id}`) });
}

export function useSavePost() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, saved }: { id: string; saved: boolean }) =>
      api<void>(`/community/${id}/save`, { method: saved ? "POST" : "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: communityKey }),
  });
}

export function useReport() {
  return useMutation({
    mutationFn: ({ path, reason }: { path: string; reason: ReportReason }) =>
      api<void>(`/community/${path}/report`, { method: "POST", body: JSON.stringify({ reason }) }),
  });
}

export function useComments(postId: string) {
  return useQuery({
    queryKey: [...communityKey, "comments", postId],
    queryFn: () => api<PublicComment[]>(`/community/${postId}/comments`),
  });
}

export function useAddComment(postId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: string) =>
      api<PublicComment>(`/community/${postId}/comments`, { method: "POST", body: JSON.stringify({ body }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: communityKey }),
  });
}

export function useDeleteComment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<void>(`/community/comments/${id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: communityKey }),
  });
}

// --- Notes into cards --------------------------------------------------------------------------------------

/** What a line of Markdown says, without its marks or its [n] references, which mean nothing to a reader. */
function plainText(line: string): string {
  return line
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\s*\[\d{1,3}\]/g, "")
    .replace(/^\s*(?:>+\s*|[-*+]\s+|\d+[.)]\s+)+/, "")
    .replace(/(\*\*|__|\*|_|`)/g, "")
    .trim();
}

/** Cuts text into pieces no longer than `max`, at sentence ends where it can and at spaces where it must. */
function pieces(text: string, max: number): string[] {
  const out: string[] = [];
  let current = "";
  const sentences = text.match(/[^.!?…]+[.!?…]*\s*/g) ?? [text];
  for (const sentence of sentences) {
    let rest = sentence.trim();
    if (!rest) continue;
    if (current && `${current} ${rest}`.length > max) {
      out.push(current);
      current = "";
    }
    while (rest.length > max) {
      const cut = rest.lastIndexOf(" ", max);
      const at = cut > 0 ? cut : max;
      out.push(rest.slice(0, at).trim());
      rest = rest.slice(at).trim();
    }
    current = current ? `${current} ${rest}` : rest;
  }
  if (current) out.push(current);
  return out;
}

/**
 * A notebook's text as cards, costing no AI: a paragraph or a heading starts a new card, a long passage runs onto
 * the next, and short paragraphs share a card only when one each would not fit.
 * It only moves the author's words around, and what does not fit in nine cards is reported, not lost quietly.
 */
export function splitIntoCards(markdown: string): { cards: PostCard[]; dropped: number } {
  const sections: { heading: string; paragraphs: string[] }[] = [];
  let current: { heading: string; paragraphs: string[] } | null = null;
  let paragraph: string[] = [];
  const flush = () => {
    const text = paragraph.join(" ").trim();
    paragraph = [];
    if (!text) return;
    if (!current) {
      current = { heading: "", paragraphs: [] };
      sections.push(current);
    }
    current.paragraphs.push(text);
  };
  for (const raw of markdown.split(/\r?\n/)) {
    const heading = raw.match(/^#{1,6}\s+(.*)$/);
    if (heading) {
      flush();
      current = { heading: plainText(heading[1]).slice(0, MAX_CARD_HEADING), paragraphs: [] };
      sections.push(current);
    } else if (!raw.trim() || /^\s*([-*_])\1{2,}\s*$/.test(raw)) {
      flush();
    } else if (/^\s*(?:[-*+]|\d+[.)])\s+/.test(raw)) {
      flush(); // each list item is a thought of its own
      paragraph.push(plainText(raw));
      flush();
    } else {
      paragraph.push(plainText(raw));
    }
  }
  flush();

  const asCards = (merge: boolean) => {
    const out: PostCard[] = [];
    for (const section of sections) {
      const chunks: string[] = [];
      let chunk = "";
      for (const text of section.paragraphs) {
        for (const piece of pieces(text, MAX_CARD_BODY)) {
          if (chunk && (!merge || chunk.length + piece.length + 2 > MAX_CARD_BODY)) {
            chunks.push(chunk);
            chunk = "";
          }
          chunk = chunk ? `${chunk}\n\n${piece}` : piece;
        }
      }
      if (chunk) chunks.push(chunk);
      chunks.forEach((body, i) => out.push({ heading: i === 0 ? section.heading : "", body }));
    }
    return out;
  };

  const each = asCards(false);
  const cards = each.length <= MAX_POST_CARDS ? each : asCards(true);
  return { cards: cards.slice(0, MAX_POST_CARDS), dropped: Math.max(0, cards.length - MAX_POST_CARDS) };
}

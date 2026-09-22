"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type { HighlightDto } from "./annotations";
import { ApiError, api, apiFetch } from "./api";
import { MSG } from "./messages";
import { accountKey } from "./queries";
import type { User } from "./types";

/** FR-NB-01..05: AI notebooks built from highlights. */

export const MAX_NOTEBOOK_SOURCES = 100;
export const MAX_NOTEBOOK_CHARS = 200_000;
export const MAX_NOTEBOOK_TITLE = 255;

export type NotebookStatus = "draft" | "saved";
/** Dịch ở chỗ hiển thị: `t(STATUS_LABEL[status])`. */
export const STATUS_LABEL = { draft: "notebooks.draft", saved: "notebooks.savedStatus" } as const;

export interface NotebookSource {
  /** The [n] number used in the content. */
  position: number;
  highlight: HighlightDto;
  document_title: string;
  file_type: "pdf" | "epub" | "web";
}

export interface Notebook {
  id: string;
  title: string;
  content: string;
  status: NotebookStatus;
  ai_model: string | null;
  sources: NotebookSource[];
  created_at: string;
  updated_at: string;
}

export interface NotebookListItem {
  id: string;
  title: string;
  status: NotebookStatus;
  source_count: number;
  created_at: string;
  updated_at: string;
}

export type NotebookLanguage = "auto" | "vi" | "en";

export const notebooksKey = ["notebooks"] as const;
const notebookKey = (id: string) => ["notebooks", "one", id] as const;

export function useNotebooks() {
  return useQuery({ queryKey: [...notebooksKey, "list"], queryFn: () => api<NotebookListItem[]>("/notebooks") });
}

/** Notebooks that cite a highlight (asked before deleting it, FR-HL-03). */
export function notebooksUsing(highlightId: string) {
  return api<NotebookListItem[]>(`/notebooks?highlight_id=${highlightId}`);
}

export function useNotebook(id: string) {
  // Refetched on every visit: opening a draft keeps it from being cleaned up (DR-03).
  return useQuery({ queryKey: notebookKey(id), queryFn: () => api<Notebook>(`/notebooks/${id}`), refetchOnWindowFocus: false });
}

export type NotebookPatch = Partial<Pick<Notebook, "title" | "content">> & {
  highlight_ids?: string[];
  status?: "saved";
};

export function useUpdateNotebook(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: NotebookPatch) => api<Notebook>(`/notebooks/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
    onSuccess: (nb, patch) => {
      qc.setQueryData(notebookKey(id), nb);
      void qc.invalidateQueries({ queryKey: [...notebooksKey, "list"] });
      if (patch.status === "saved") void qc.invalidateQueries({ queryKey: versionsKey(id) });
    },
  });
}

/** FR-NB-03 step 5: a snapshot kept each time the notebook is saved with "Lưu". */
export interface NotebookVersionItem {
  id: string;
  title: string;
  chars: number;
  created_at: string;
}

export interface NotebookVersion {
  id: string;
  title: string;
  content: string;
  created_at: string;
}

// Kept apart from notebookKey: refetching the notebook itself would count as opening it.
const versionsKey = (id: string) => ["notebook-versions", id] as const;

export function useNotebookVersions(id: string, enabled: boolean) {
  return useQuery({
    queryKey: [...versionsKey(id), "list"],
    queryFn: () => api<NotebookVersionItem[]>(`/notebooks/${id}/versions`),
    enabled,
  });
}

export function useNotebookVersion(id: string, versionId: string | null) {
  return useQuery({
    queryKey: [...versionsKey(id), "one", versionId],
    queryFn: () => api<NotebookVersion>(`/notebooks/${id}/versions/${versionId}`),
    enabled: versionId !== null,
    staleTime: Infinity, // a snapshot never changes
  });
}

export function useDeleteNotebook() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<void>(`/notebooks/${id}`, { method: "DELETE" }),
    onSuccess: (_, id) => {
      qc.removeQueries({ queryKey: notebookKey(id) });
      void qc.invalidateQueries({ queryKey: notebooksKey });
    },
  });
}

/** Splits a text/event-stream body into (event, data) pairs as they arrive. */
export async function* readEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<{ event: string; data: string }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value, { stream: !done }).replace(/\r\n?/g, "\n");
    let end: number;
    while ((end = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      let event = "message";
      const data: string[] = [];
      for (const line of block.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
      }
      if (data.length) yield { event, data: data.join("\n") };
    }
    if (done) return;
  }
}

/**
 * FR-NB-02: asks the AI for a notebook, calling `onDelta` with the Markdown as it is written.
 * Resolves with the saved draft; throws ApiError (MSG-26 etc.) when it fails — nothing is saved then.
 */
export async function generateNotebook(
  input: { highlight_ids: string[]; title?: string; language?: NotebookLanguage },
  onDelta: (text: string) => void,
  signal?: AbortSignal,
): Promise<Notebook> {
  const body: Record<string, unknown> = { highlight_ids: input.highlight_ids };
  if (input.title?.trim()) body.title = input.title.trim();
  if (input.language && input.language !== "auto") body.language = input.language;

  const res = await apiFetch("/notebooks/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.body) throw new ApiError(0, MSG["MSG-99"]);
  try {
    for await (const { event, data } of readEvents(res.body)) {
      const payload = JSON.parse(data);
      if (event === "delta") onDelta(payload.text);
      else if (event === "done") return payload as Notebook;
      else if (event === "error") throw new ApiError(502, payload.detail ?? MSG["MSG-26"]);
    }
  } catch (e) {
    if (e instanceof ApiError || signal?.aborted) throw e;
    throw new ApiError(0, MSG["MSG-26"]); // connection dropped mid-stream
  }
  throw new ApiError(0, MSG["MSG-26"]);
}

/** After a successful generation: one AI request used, the list has a new draft. */
export function afterGenerate(qc: ReturnType<typeof useQueryClient>, nb: Notebook) {
  qc.setQueryData(notebookKey(nb.id), nb);
  qc.setQueryData<User>(accountKey, (u) => (u ? { ...u, ai_quota_remaining: Math.max(0, u.ai_quota_remaining - 1) } : u));
  void qc.invalidateQueries({ queryKey: [...notebooksKey, "list"] });
}

/** Reference numbers [n] used in the content, in order of first use. */
export function citedPositions(content: string): number[] {
  const seen = new Set<number>();
  for (const m of content.matchAll(/\[(\d{1,3})\]/g)) seen.add(Number(m[1]));
  return [...seen];
}

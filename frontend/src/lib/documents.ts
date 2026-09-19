"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { highlightsKey } from "./annotations";
import { api } from "./api";
import type { DocumentDetail, DocumentListItem } from "./types";

export type LibrarySort = "created_desc" | "created_asc" | "title";

export const documentsKey = ["documents"] as const;

export type SourceFilter = "all" | "upload" | "manual";

const isExtracting = (d?: DocumentListItem) => d?.extraction_status === "pending" || d?.extraction_status === "processing";

export function useDocuments(sort: LibrarySort, source: SourceFilter = "all") {
  const params = new URLSearchParams({ sort });
  if (source !== "all") params.set("source_type", source);
  return useQuery({
    queryKey: [...documentsKey, "list", sort, source],
    queryFn: () => api<DocumentListItem[]>(`/documents?${params}`),
    // FR-DOC-02 step 6: poll every 2 s while a large file is still being extracted
    refetchInterval: (q) => (q.state.data?.some(isExtracting) ? 2000 : false),
  });
}

export function useDocument(id: string) {
  return useQuery({
    queryKey: [...documentsKey, "detail", id],
    queryFn: () => api<DocumentDetail>(`/documents/${id}`),
    refetchInterval: (q) => (isExtracting(q.state.data) ? 2000 : false),
  });
}

export function useUploadDocument() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (file: File) => {
      const body = new FormData();
      body.append("file", file);
      return api<DocumentDetail>("/documents/upload", { method: "POST", body });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: documentsKey }),
  });
}

export function useSaveUrl() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (url: string) =>
      api<DocumentDetail>("/documents/save-url", { method: "POST", body: JSON.stringify({ url }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: documentsKey }),
  });
}

export function sourceDomain(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

export function useDeleteDocument() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<void>(`/documents/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: highlightsKey }); // removed with the document
      return qc.invalidateQueries({ queryKey: documentsKey });
    },
  });
}

export function updateDocument(id: string, patch: Partial<Pick<DocumentDetail, "title" | "last_read_page" | "read_fraction" | "is_read" | "note">>) {
  return api<DocumentDetail>(`/documents/${id}`, { method: "PATCH", body: JSON.stringify(patch) });
}

export const MAX_DOCUMENT_TITLE = 500;

/** F-16: rename, mark read / unread from the library. */
export function useUpdateDocument() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Partial<Pick<DocumentDetail, "title" | "is_read">> }) =>
      updateDocument(id, patch),
    onSuccess: () => qc.invalidateQueries({ queryKey: documentsKey }),
  });
}

export function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString("vi-VN", { day: "2-digit", month: "2-digit", year: "numeric" });
}

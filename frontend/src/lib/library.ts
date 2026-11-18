"use client";

/** The Library Dashboard: shelves, what removing a document affects, and how the documents are narrowed down. */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "./api";
import { isProcessing, origin, progressOf, readStateOf, type ReadState } from "./doc-view";
import { documentsKey } from "./documents";
import { normalize } from "./find";
import type { DocumentListItem } from "./types";

export const MAX_COLLECTION_NAME = 80;

export interface Collection {
  id: string;
  name: string;
  document_count: number;
}

export interface DocumentUsage {
  highlights: number;
  notes: number;
  has_summary: boolean;
  notebooks: number;
}

export const collectionsKey = ["collections"] as const;

export function useCollections() {
  return useQuery({ queryKey: collectionsKey, queryFn: () => api<Collection[]>("/collections") });
}

export function useCreateCollection() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => api<Collection>("/collections", { method: "POST", body: JSON.stringify({ name }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: collectionsKey }),
  });
}

export function useRenameCollection() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) =>
      api<Collection>(`/collections/${id}`, { method: "PATCH", body: JSON.stringify({ name }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: collectionsKey }),
  });
}

/** The documents stay in the library, off any shelf. */
export function useDeleteCollection() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<void>(`/collections/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: collectionsKey });
      void qc.invalidateQueries({ queryKey: documentsKey });
    },
  });
}

export function useMoveDocument() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, collectionId }: { id: string; collectionId: string | null }) =>
      api<DocumentListItem>(`/documents/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ collection_id: collectionId }),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: collectionsKey });
      void qc.invalidateQueries({ queryKey: documentsKey });
    },
  });
}

/** Fetched afresh each time: the dialog states these numbers as what will happen. */
export function useDocumentUsage(id: string | null) {
  return useQuery({
    queryKey: ["document-usage", id],
    queryFn: () => api<DocumentUsage>(`/documents/${id}/usage`),
    enabled: id !== null,
    gcTime: 0,
    staleTime: 0,
  });
}

/** CC BY-ND: it may be linked to, but never summarised, translated or adapted. */
export const noDerivatives = (license: string | null | undefined) => (license ?? "").toUpperCase().includes("ND");

const readable = (d: DocumentListItem) => d.extraction_status === "done" || (d.file_type === "pdf" && !isProcessing(d));

/** Started and unfinished, last touched first; failing that, the newest one not yet read. */
export function continueReading(docs: DocumentListItem[], n = 3): DocumentListItem[] {
  const open = docs.filter(readable);
  const started = open
    .filter((d) => {
      const p = progressOf(d);
      return p > 0 && p < 100;
    })
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  if (started.length) return started.slice(0, n);
  const next = open.find((d) => !d.is_read);
  return next ? [next] : [];
}

export interface LibraryFilters {
  source: "all" | "upload" | "manual";
  readState: ReadState | "all";
  fileType: DocumentListItem["file_type"] | "all";
  topic: string;
  collection: string | null;
  query: string;
}

export const NO_FILTERS: LibraryFilters = {
  source: "all",
  readState: "all",
  fileType: "all",
  topic: "",
  collection: null,
  query: "",
};

export function filterDocuments(docs: DocumentListItem[], f: LibraryFilters): DocumentListItem[] {
  const q = normalize(f.query.trim());
  return docs
    .filter((d) => f.collection === null || d.collection_id === f.collection)
    .filter((d) => f.source === "all" || d.source_type === f.source)
    .filter((d) => f.readState === "all" || readStateOf(d) === f.readState)
    .filter((d) => f.fileType === "all" || d.file_type === f.fileType)
    .filter((d) => !f.topic || d.topics.includes(f.topic))
    .filter((d) => !q || normalize(`${d.title} ${origin(d)}`).includes(q));
}

/** How many documents are in each reading state: the numbers on the list's tabs. */
export function readCounts(docs: DocumentListItem[]): Record<ReadState | "all", number> {
  const counts = { all: docs.length, unread: 0, reading: 0, read: 0 };
  for (const d of docs) counts[readStateOf(d)] += 1;
  return counts;
}

/** The row a keystroke moves to: one up or down the list, stopping at its ends. With none chosen, the first. */
export function stepSelection(ids: string[], current: string | null, delta: 1 | -1): string | null {
  if (!ids.length) return null;
  const at = current === null ? -1 : ids.indexOf(current);
  if (at < 0) return ids[0];
  return ids[Math.min(ids.length - 1, Math.max(0, at + delta))];
}

/** Who wrote it, short enough for one line of a list: "Nguyen", "Nguyen & Tran", "Nguyen et al.". */
export function authorsShort(doc: DocumentListItem): string {
  const names = (doc.citation?.authors ?? []).map((a) => a.family.trim()).filter(Boolean);
  if (names.length <= 2) return names.join(" & ");
  return `${names[0]} et al.`;
}

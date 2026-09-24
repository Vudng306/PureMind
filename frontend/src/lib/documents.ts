"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { highlightsKey } from "./annotations";
import { api, apiUpload } from "./api";
import { currentLang } from "./preferences";
import type { DocumentDetail, DocumentListItem, Lang } from "./types";

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
    mutationFn: ({ file, onProgress }: { file: File; onProgress: (fraction: number) => void }) => {
      const body = new FormData();
      body.append("file", file);
      return apiUpload<DocumentDetail>("/documents/upload", body, onProgress);
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

export function formatDate(iso: string, lang: Lang = currentLang()) {
  return new Date(iso).toLocaleDateString(lang === "en" ? "en-GB" : "vi-VN", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

/** A block's place on the original PDF: its page and a box as fractions of the page. */
export type SourceBox = { page: number; x: number; y: number; w: number; h: number };

/**
 * Where each block of the clean text sits on the PDF, by block id. The server lists the blocks in reading
 * order by the key their id is made from, so the nth time a key comes back is the block with suffix "-n".
 */
export function sourceBoxes(entries: [string, number[][]][]): Map<string, SourceBox[]> {
  const out = new Map<string, SourceBox[]>();
  const counts = new Map<string, number>();
  for (const [key, boxes] of entries) {
    const n = counts.get(key) ?? 0;
    counts.set(key, n + 1);
    out.set(`b${key}${n ? `-${n}` : ""}`, boxes.map(([page, x, y, w, h]) => ({ page, x, y, w, h })));
  }
  return out;
}

export function useSourceMap(id: string, enabled: boolean) {
  return useQuery({
    queryKey: [...documentsKey, "source-map", id],
    queryFn: async () => sourceBoxes(await api<[string, number[][]][]>(`/documents/${id}/source-map`)),
    enabled,
    staleTime: Infinity,
  });
}

export type ChartAxis = { title: string; scale: "linear" | "log" };
export type ChartSeries = { name: string; color: string; points: [number, number][] };
export type ChartPanel = { title: string; x: ChartAxis; y: ChartAxis; series: ChartSeries[] };
/** The data points of a chart drawn as vector paths in the PDF, read from the drawing (not from its picture). */
export type Chart = { panels: ChartPanel[] };

/** The document's vector charts, by the name of their image (`pm-image:<name>`). */
export function useCharts(id: string, enabled: boolean) {
  return useQuery({
    queryKey: [...documentsKey, "charts", id],
    queryFn: () => api<Record<string, Chart>>(`/documents/${id}/charts`),
    enabled,
    staleTime: Infinity,
  });
}

const csvCell = (v: string | number) => {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** One panel's points as CSV, one row per point: series, x, y (the axes' titles as headers). */
export function chartCsv(panel: ChartPanel): string {
  const rows = [["series", panel.x.title || "x", panel.y.title || "y"]];
  panel.series.forEach((s, i) => {
    for (const [x, y] of s.points) rows.push([s.name || `${i + 1}`, String(x), String(y)]);
  });
  return rows.map((r) => r.map(csvCell).join(",")).join("\n") + "\n";
}

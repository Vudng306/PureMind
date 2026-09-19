import { sourceDomain } from "./documents";
import type { DocumentListItem } from "./types";

export const KIND_LABEL = { pdf: "PDF", epub: "EPUB", web: "WEB" } as const;

/** Cover / badge color class per kind (defined in globals.css, with dark-theme variants). */
export const KIND_CLASS = { pdf: "kind-pdf", epub: "kind-epub", web: "kind-web" } as const;

export function origin(doc: DocumentListItem): string {
  if (doc.source_type === "manual") return sourceDomain(doc.url) ?? "Link";
  return doc.original_filename ?? "Tệp tải lên";
}

export const isProcessing = (doc: DocumentListItem) =>
  doc.extraction_status === "pending" || doc.extraction_status === "processing";

/**
 * Reading progress 0–100: PDF page position, otherwise the clean-text scroll position.
 * Only `is_read` counts as finished, so a document marked unread at its last page shows 99%.
 */
export function progressOf(doc: DocumentListItem): number {
  if (doc.is_read) return 100;
  const pct =
    doc.page_count && doc.last_read_page && doc.last_read_page > 1
      ? (doc.last_read_page / doc.page_count) * 100
      : (doc.read_fraction ?? 0) * 100;
  return Math.min(99, Math.round(pct));
}

export type ReadState = "unread" | "reading" | "read";

export function readStateOf(doc: DocumentListItem): ReadState {
  const pct = progressOf(doc);
  return pct >= 100 ? "read" : pct > 0 ? "reading" : "unread";
}

export function progressLabel(doc: DocumentListItem, pct: number): string {
  if (doc.is_read || pct >= 100) return "Đã đọc xong";
  if (pct <= 0) {
    if (doc.page_count) return `Chưa đọc · ${doc.page_count} trang`;
    if (doc.reading_minutes) return `Chưa đọc · ~${doc.reading_minutes} phút`;
    return "Chưa đọc";
  }
  if (doc.page_count && doc.last_read_page) return `Trang ${doc.last_read_page}/${doc.page_count} · ${pct}%`;
  return `Đã đọc ${pct}%`;
}

export function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const min = Math.round(diff / 60000);
  if (min < 1) return "vừa xong";
  if (min < 60) return `${min} phút trước`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} giờ trước`;
  const d = Math.round(h / 24);
  if (d === 1) return "hôm qua";
  if (d < 7) return `${d} ngày trước`;
  return new Date(iso).toLocaleDateString("vi-VN", { day: "2-digit", month: "2-digit", year: "numeric" });
}

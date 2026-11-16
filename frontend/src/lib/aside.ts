"use client";

import { useMutation, useQuery } from "@tanstack/react-query";

import { api } from "./api";
import { documentsKey, type SourceBox } from "./documents";
import type { Key } from "./i18n";

/**
 * Clean Reader (CR-FR-13): the blocks the extraction took out of the reading flow and kept on the side —
 * authors, affiliations, the journal's lines, references, funding, running headers, page numbers… Nothing is
 * deleted: each block keeps its page and box on the PDF, its type, and why it was set aside.
 */
export type AsideBlock = {
  id: number;
  type: string;
  text: string;
  page: number;
  /** x, y, w, h as fractions of the page. */
  box: [number, number, number, number];
  confidence: number;
  reason: string;
};
/** `classifier` is null for a document extracted before blocks were kept on the side. */
export type Aside = { classifier: string | null; blocks: AsideBlock[] };

export type AsideGroup = "metadata" | "supplementary" | "furniture";

/** What each type is, in the order the reader is shown them within its group. */
export const ASIDE_TYPES: Record<string, { group: AsideGroup; label: Key }> = {
  AUTHORS: { group: "metadata", label: "aside.AUTHORS" },
  AFFILIATIONS: { group: "metadata", label: "aside.AFFILIATIONS" },
  KEYWORDS: { group: "metadata", label: "aside.KEYWORDS" },
  PUBLISHER_INFO: { group: "metadata", label: "aside.PUBLISHER_INFO" },
  BIOGRAPHY: { group: "metadata", label: "aside.BIOGRAPHY" },
  FRONT_MATTER: { group: "metadata", label: "aside.FRONT_MATTER" },
  ACKNOWLEDGEMENTS: { group: "supplementary", label: "aside.ACKNOWLEDGEMENTS" },
  FUNDING: { group: "supplementary", label: "aside.FUNDING" },
  CONFLICT_OF_INTEREST: { group: "supplementary", label: "aside.CONFLICT_OF_INTEREST" },
  AUTHOR_CONTRIBUTIONS: { group: "supplementary", label: "aside.AUTHOR_CONTRIBUTIONS" },
  DATA_AVAILABILITY: { group: "supplementary", label: "aside.DATA_AVAILABILITY" },
  DECLARATION: { group: "supplementary", label: "aside.DECLARATION" },
  TABLE_OF_CONTENTS: { group: "supplementary", label: "aside.TABLE_OF_CONTENTS" },
  APPENDIX: { group: "supplementary", label: "aside.APPENDIX" },
  REFERENCES: { group: "supplementary", label: "aside.REFERENCES" },
  RUNNING_HEADER: { group: "furniture", label: "aside.RUNNING_HEADER" },
  RUNNING_FOOTER: { group: "furniture", label: "aside.RUNNING_FOOTER" },
  PAGE_NUMBER: { group: "furniture", label: "aside.PAGE_NUMBER" },
  WATERMARK: { group: "furniture", label: "aside.WATERMARK" },
  DECORATION: { group: "furniture", label: "aside.DECORATION" },
};
const ORDER = Object.keys(ASIDE_TYPES);

export const asideGroup = (type: string): AsideGroup => ASIDE_TYPES[type]?.group ?? "furniture";
export const asideLabel = (type: string): Key => ASIDE_TYPES[type]?.label ?? "aside.OTHER";

/** Parts read at the end of the article, folded (references, appendix…); the rest are front matter. */
export const END_PARTS = new Set([
  "ACKNOWLEDGEMENTS",
  "FUNDING",
  "CONFLICT_OF_INTEREST",
  "AUTHOR_CONTRIBUTIONS",
  "DATA_AVAILABILITY",
  "APPENDIX",
  "REFERENCES",
]);

export function useAside(id: string, enabled: boolean) {
  return useQuery({
    queryKey: [...documentsKey, "aside", id],
    queryFn: () => api<Aside>(`/documents/${id}/aside`),
    enabled,
    staleTime: 60_000,
  });
}

/** The block's words as plain text: no Markdown marks, no picture (a logo over the title). */
export function asideText(text: string): string {
  return text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*|__/g, "")
    .replace(/\s*<br>\s*/g, " ")
    .trim();
}

/** A heading of the part ("## References"), shown bold in it. */
export const isHeading = (text: string) => /^#{1,6}\s/.test(text);

/** Where the block is on the PDF, as the original view shows a passage. */
export const asideBoxes = (b: AsideBlock): SourceBox[] => [
  { page: b.page, x: b.box[0], y: b.box[1], w: b.box[2], h: b.box[3] },
];

/** One type of block, all of it, in document order: the parts of the Info tab and the end of the article. */
export type AsidePart = { type: string; blocks: AsideBlock[] };

export function asideParts(blocks: AsideBlock[], group: AsideGroup): AsidePart[] {
  const parts = new Map<string, AsideBlock[]>();
  for (const b of blocks) {
    if (asideGroup(b.type) !== group || !asideText(b.text)) continue;
    parts.set(b.type, [...(parts.get(b.type) ?? []), b]);
  }
  return [...parts]
    .map(([type, list]) => ({ type, blocks: list }))
    .sort((a, b) => ORDER.indexOf(a.type) - ORDER.indexOf(b.type));
}

/** The kinds of error the reader can report (CR-FR-15, SRS §6.1). */
export const EXTRACTION_ERRORS = [
  "missing_text",
  "wrong_order",
  "metadata_in_body",
  "missing_media",
  "ocr_error",
  "wrongly_hidden",
  "other",
] as const;
export type ExtractionError = (typeof EXTRACTION_ERRORS)[number];

export type ExtractionReportIn = { error_type: ExtractionError; page?: number | null; block?: number | null; note?: string | null };

export function useReportExtraction(id: string) {
  return useMutation({
    mutationFn: (body: ExtractionReportIn) =>
      api<{ id: string }>(`/documents/${id}/extraction-reports`, { method: "POST", body: JSON.stringify(body) }),
  });
}

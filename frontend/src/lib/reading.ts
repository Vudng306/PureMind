import type { ExtractionIssue, ReadPosition } from "./types";

/** Where the reader was in a document: the clean text by block and fraction, the original by page. */
export interface Resume {
  fraction: number;
  position: ReadPosition | null;
  page: number | null;
}

/** A place worth offering to go back to; the very start of a document is not one. */
export function resumeOf(place: {
  fraction?: number | null;
  position?: ReadPosition | null;
  page?: number | null;
}): Resume | null {
  const fraction = place.fraction ?? 0;
  const page = place.page ?? null;
  if (fraction < 0.005 && (page ?? 1) <= 1) return null;
  return { fraction, position: place.position ?? null, page };
}

/** The place as the account keeps it: the offset stays inside the block. */
export function toPosition(place: { blockId: string; offset: number }): ReadPosition {
  return { block_id: place.blockId, offset: Math.round(Math.min(1, Math.max(0, place.offset)) * 10000) / 10000 };
}

// RD-107: a visit to a passage (a citation, a highlight, a search hit) is a look, not reading on. It becomes
// reading on once the reader has moved this far from where the visit landed.
export const DETOUR_SCREENS = 2;
export const DETOUR_PAGES = 2;

export function readOn(landTop: number, top: number, view: number): boolean {
  return view > 0 && Math.abs(top - landTop) > DETOUR_SCREENS * view;
}

export function readOnPages(landPage: number, page: number): boolean {
  return Math.abs(page - landPage) >= DETOUR_PAGES;
}

// Text that is missing from the clean copy (RD-111). A page read by OCR is there, only less sure.
const MISSING: ExtractionIssue["code"][] = ["scanned_pages", "tables_as_images", "equations_as_images"];

/** What there is to tell the reader about, in a fixed order. */
export function shownIssues(issues: ExtractionIssue[] | null | undefined): ExtractionIssue[] {
  const order: ExtractionIssue["code"][] = ["scanned_pages", "tables_as_images", "equations_as_images", "ocr_pages"];
  return (issues ?? []).filter((i) => i.count > 0).sort((a, b) => order.indexOf(a.code) - order.indexOf(b.code));
}

export function isPartial(issues: ExtractionIssue[] | null | undefined): boolean {
  return shownIssues(issues).some((i) => MISSING.includes(i.code));
}

/** "2–4, 7, 9" for pages 2, 3, 4, 7 and 9; after `max` runs the rest is an ellipsis. */
export function pageRuns(pages: number[], max = 6): string {
  const sorted = [...new Set(pages)].sort((a, b) => a - b);
  const runs: [number, number][] = [];
  for (const p of sorted) {
    const last = runs[runs.length - 1];
    if (last && p === last[1] + 1) last[1] = p;
    else runs.push([p, p]);
  }
  const text = runs.slice(0, max).map(([a, b]) => (a === b ? `${a}` : `${a}–${b}`));
  return text.join(", ") + (runs.length > max ? ", …" : "");
}

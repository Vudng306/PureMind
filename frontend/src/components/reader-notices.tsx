"use client";

import { useT, type Key } from "@/lib/i18n";
import { isPartial, pageRuns, shownIssues } from "@/lib/reading";
import type { ExtractionIssue } from "@/lib/types";

import { Icon } from "./icons";

const ISSUE: Record<ExtractionIssue["code"], Key> = {
  scanned_pages: "reader.issueScanned",
  ocr_pages: "reader.issueOcr",
  tables_as_images: "reader.issueTables",
  equations_as_images: "reader.issueEquations",
};

/**
 * RD-111: what the extraction knows is not in the clean text as text. It sits above the title, in the flow of
 * the page, so it is seen once and never covers what is being read.
 */
export function IntegrityNotice({
  issues,
  onOriginal,
  sourceUrl,
}: {
  issues: ExtractionIssue[] | null;
  /** Switch to the original PDF; left out for a document that has none here. */
  onOriginal?: () => void;
  sourceUrl?: string | null;
}) {
  const t = useT();
  const shown = shownIssues(issues);
  if (!shown.length) return null;
  const partial = isPartial(issues);
  return (
    <aside
      role="note"
      data-integrity={partial ? "partial" : "ocr"}
      className="mb-7 flex select-none flex-col gap-2 rounded-[12px] border border-line bg-soft px-4 py-3 text-left font-sans text-[13px] leading-relaxed text-body"
    >
      <span className="font-semibold text-ink">{t(partial ? "reader.partialTitle" : "reader.ocrTitle")}</span>
      <ul className="list-disc pl-5">
        {shown.map((issue) => (
          <li key={issue.code}>
            {t(ISSUE[issue.code], { n: issue.count })}
            {issue.pages?.length ? ` (${t("reader.issuePages", { pages: pageRuns(issue.pages) })})` : ""}
          </li>
        ))}
      </ul>
      <span className="text-muted">{t("reader.partialHint")}</span>
      {(onOriginal || sourceUrl) && (
        <div className="flex flex-wrap gap-2 pt-0.5">
          {onOriginal && (
            <button type="button" className="chip h-8 bg-surface text-[13px]" onClick={onOriginal}>
              <Icon name="file" size={14} />
              {t("reader.viewOriginal")}
            </button>
          )}
          {sourceUrl && (
            <a href={sourceUrl} target="_blank" rel="noopener noreferrer" className="chip h-8 bg-surface text-[13px]">
              <Icon name="link" size={14} />
              {t("reader.openSource")}
            </a>
          )}
        </div>
      )}
    </aside>
  );
}

/**
 * RD-107: shown while the reader is only visiting a passage. The saved place stays where it was, and this
 * goes back to it; closing it means "I am reading on from here".
 */
export function ResumeChip({ where, onBack, onDismiss }: { where: string; onBack: () => void; onDismiss: () => void }) {
  const t = useT();
  return (
    <div
      data-resume
      className="absolute bottom-5 left-1/2 z-10 flex h-10 -translate-x-1/2 items-center rounded-full border border-line bg-surface pl-1 pr-1 font-sans text-[13px] shadow-float"
    >
      <button type="button" onClick={onBack} className="flex h-8 items-center gap-1.5 rounded-full px-3 font-medium text-ink hover:bg-soft">
        <Icon name="history" size={15} className="text-accent-text" />
        <span className="whitespace-nowrap">{t("reader.resume", { where })}</span>
      </button>
      <button
        type="button"
        onClick={onDismiss}
        aria-label={t("reader.resumeDismiss")}
        title={t("reader.resumeDismiss")}
        className="grid h-8 w-8 place-items-center rounded-full text-muted hover:bg-soft hover:text-ink"
      >
        <Icon name="x" size={14} />
      </button>
    </div>
  );
}

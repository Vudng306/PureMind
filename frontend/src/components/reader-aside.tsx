"use client";

import { useEffect, useMemo, useState } from "react";

import {
  END_PARTS,
  EXTRACTION_ERRORS,
  asideBoxes,
  asideGroup,
  asideLabel,
  asideParts,
  asideText,
  isHeading,
  useReportExtraction,
  type Aside,
  type AsideBlock,
  type AsideGroup,
  type AsidePart,
  type ExtractionError,
} from "@/lib/aside";
import type { SourceBox } from "@/lib/documents";
import { useLang, useT, type Key } from "@/lib/i18n";
import { useUi } from "@/lib/ui-store";

import { Icon } from "./icons";
import { Alert, useModal } from "./ui";

/** Show a passage on the original PDF; left out where the document has no PDF. */
type OnSource = ((boxes: SourceBox[]) => void) | undefined;

function PageLink({ block, onSource }: { block: AsideBlock; onSource: OnSource }) {
  const t = useT();
  const label = t("aside.page", { n: block.page });
  if (!onSource) return <span className="text-xs text-muted">{label}</span>;
  return (
    <button
      type="button"
      onClick={() => onSource(asideBoxes(block))}
      className="shrink-0 text-xs font-medium text-accent-text hover:underline"
      title={t("aside.showOnPdf")}
    >
      {label}
    </button>
  );
}

/** The blocks of one part, each with where it is on the PDF. Headings ("References") stand out. */
function PartBlocks({ part, onSource, clamp = false }: { part: AsidePart; onSource: OnSource; clamp?: boolean }) {
  return (
    <ul className="flex flex-col gap-2">
      {part.blocks.map((b) => (
        <li key={b.id} className="flex items-baseline gap-2">
          <span
            className={`min-w-0 flex-1 whitespace-pre-line break-words ${isHeading(b.text) ? "font-semibold text-ink" : "text-body"} ${clamp ? "line-clamp-4" : ""}`}
          >
            {asideText(b.text)}
          </span>
          <PageLink block={b} onSource={onSource} />
        </li>
      ))}
    </ul>
  );
}

function Fold({ part, onSource, count, children }: { part: AsidePart; onSource: OnSource; count: string; children?: React.ReactNode }) {
  const t = useT();
  return (
    <details className="group rounded-xl border border-line bg-surface">
      <summary className="flex cursor-pointer list-none items-center gap-2 rounded-xl px-3 py-2.5 hover:bg-soft/60 [&::-webkit-details-marker]:hidden">
        <span className="min-w-0 flex-1 text-sm font-semibold text-ink">{t(asideLabel(part.type))}</span>
        <span className="text-xs text-muted">{count}</span>
        <Icon name="next" size={15} className="shrink-0 text-muted transition-transform group-open:rotate-90" />
      </summary>
      <div className="border-t border-line px-3 py-3 text-[13px] leading-relaxed">
        {children ?? <PartBlocks part={part} onSource={onSource} />}
      </div>
    </details>
  );
}

/** Where a part is in the PDF: "tr. 15–18". A block is not an entry (one can hold a whole list, or half of one). */
function pageSpan(part: AsidePart, t: ReturnType<typeof useT>) {
  const pages = part.blocks.map((b) => b.page);
  const from = Math.min(...pages);
  const to = Math.max(...pages);
  return from === to ? t("aside.page", { n: from }) : t("aside.pages", { from, to });
}

/**
 * The Info tab's "Thông tin tài liệu" (SRS §6.1): authors, affiliations, the journal's lines, keywords —
 * what the extraction took off the top of the article, as the PDF printed it.
 */
export function DocumentInfoSection({ aside, onSource }: { aside: Aside; onSource: OnSource }) {
  const t = useT();
  const lang = useLang();
  const parts = asideParts(aside.blocks, "metadata");
  if (!parts.length) return null;
  return (
    <section className="flex flex-col gap-3" data-aside="metadata">
      <h3 className="eyebrow">{t("aside.docInfo").toLocaleUpperCase(lang)}</h3>
      {parts.map((part) => (
        <div key={part.type} className="flex flex-col gap-1.5 text-[13px] leading-relaxed">
          <span className="text-muted">{t(asideLabel(part.type))}</span>
          <PartBlocks part={part} onSource={onSource} clamp />
        </div>
      ))}
    </section>
  );
}

/** The Info tab's "Thông tin bổ sung": funding, acknowledgements, conflicts, references…, each folded. */
export function AdditionalInfoSection({ aside, onSource }: { aside: Aside; onSource: OnSource }) {
  const t = useT();
  const lang = useLang();
  const parts = asideParts(aside.blocks, "supplementary");
  if (!parts.length) return null;
  return (
    <section className="flex flex-col gap-2" data-aside="supplementary">
      <h3 className="eyebrow">{t("aside.additionalInfo").toLocaleUpperCase(lang)}</h3>
      {parts.map((part) => (
        <Fold key={part.type} part={part} onSource={onSource} count={pageSpan(part, t)} />
      ))}
    </section>
  );
}

/**
 * TC-07: at the end of the article, the parts that close it (references, appendix, funding…), folded. They are
 * out of the reading flow (and of highlights, search and the AI) but one click away, never gone.
 */
export function ArticleEnd({ aside, onSource }: { aside: Aside | undefined; onSource: OnSource }) {
  const t = useT();
  const parts = asideParts(aside?.blocks ?? [], "supplementary").filter((p) => END_PARTS.has(p.type));
  if (!parts.length) return null;
  return (
    <aside className="mt-12 flex select-none flex-col gap-2 border-t border-line pt-6 font-sans" data-article-end aria-label={t("aside.additionalInfo")}>
      {parts.map((part) => (
        <Fold
          key={part.type}
          part={part}
          onSource={onSource}
          count={part.type === "REFERENCES" ? pageSpan(part, t) : ""}
        />
      ))}
    </aside>
  );
}

/** Under the title: who wrote it, as the PDF printed it, when the citation does not say. */
export function AsideAuthors({ aside, onInfo }: { aside: Aside | undefined; onInfo: () => void }) {
  const t = useT();
  // The names only: not the contact line or the notes on them ("†These authors contributed equally…").
  const authors = (aside?.blocks ?? [])
    .filter((b) => b.type === "AUTHORS")
    .map((b) => asideText(b.text))
    .filter((text) => text && !/@|correspond|contributed|contribution|authorship/i.test(text) && !/^[*†‡§]/.test(text))
    .filter((text, n, all) => !all.some((other, k) => k !== n && other.length > text.length && other.includes(text)));
  if (!authors.length) return null;
  return (
    <p className="-mt-4 mb-7 font-sans text-[14px] leading-snug text-muted">
      <span className="line-clamp-2">{authors.join(" · ").replace(/[*†‡]|⁽B⁾/g, "")}</span>
      <button type="button" onClick={onInfo} className="mt-1 text-[13px] font-medium text-accent-text hover:underline">
        {t("aside.docInfo")}
      </button>
    </p>
  );
}

const GROUP_LABEL: Record<AsideGroup, Key> = {
  metadata: "aside.groupMetadata",
  supplementary: "aside.groupSupplementary",
  furniture: "aside.groupFurniture",
};

/**
 * UC-02, TC-19: every block taken out of the reading flow, with its type, page and why — to check the
 * extraction against the PDF and report a block hidden by mistake.
 */
export function HiddenBlocksDialog({
  open,
  aside,
  onClose,
  onSource,
  onReport,
}: {
  open: boolean;
  aside: Aside | undefined;
  onClose: () => void;
  onSource: OnSource;
  onReport: (block: AsideBlock) => void;
}) {
  const t = useT();
  const ref = useModal(open);
  const [group, setGroup] = useState<AsideGroup | "all">("all");
  const blocks = useMemo(() => aside?.blocks ?? [], [aside]);
  const counts = useMemo(() => {
    const c: Record<AsideGroup, number> = { metadata: 0, supplementary: 0, furniture: 0 };
    for (const b of blocks) c[asideGroup(b.type)] += 1;
    return c;
  }, [blocks]);
  const shown = group === "all" ? blocks : blocks.filter((b) => asideGroup(b.type) === group);

  return (
    <dialog
      ref={ref}
      aria-label={t("aside.hiddenTitle")}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => e.target === e.currentTarget && onClose()}
      className="dialog w-[min(calc(100vw-32px),640px)]"
    >
      <div className="flex max-h-[min(80vh,720px)] flex-col">
        <div className="flex items-start gap-3 border-b border-line p-5 pb-4">
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <h2 className="font-serif text-2xl font-medium">{t("aside.hiddenTitle")}</h2>
            {blocks.length > 0 && <p className="text-[13px] leading-relaxed text-muted">{t("aside.hiddenLede")}</p>}
          </div>
          <button type="button" onClick={onClose} className="icon-btn h-9 w-9" aria-label={t("common.close")}>
            <Icon name="x" size={16} />
          </button>
        </div>
        {aside?.classifier == null ? (
          <p className="p-5 text-sm leading-relaxed text-body">{t("aside.oldExtraction")}</p>
        ) : !blocks.length ? (
          <p className="p-5 text-sm leading-relaxed text-body">{t("aside.nothingHidden")}</p>
        ) : (
          <>
            <div role="tablist" aria-label={t("aside.hiddenTitle")} className="flex flex-wrap gap-1.5 px-5 pt-3">
              {(["all", "metadata", "supplementary", "furniture"] as const).map((g) => (
                <button
                  key={g}
                  type="button"
                  role="tab"
                  aria-selected={group === g}
                  onClick={() => setGroup(g)}
                  className="chip h-8 text-[13px]"
                  disabled={g !== "all" && !counts[g]}
                >
                  {g === "all" ? t("aside.groupAll") : t(GROUP_LABEL[g])} · {g === "all" ? blocks.length : counts[g]}
                </button>
              ))}
            </div>
            <ul className="mt-2 min-h-0 flex-1 overflow-y-auto px-5 pb-5" data-hidden-list>
              {shown.map((b) => (
                <li key={b.id} className="flex flex-col gap-1 border-b border-line py-2.5 last:border-b-0">
                  <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted">
                    <span className="font-semibold text-ink">{t(asideLabel(b.type))}</span>
                    <span>{t("aside.page", { n: b.page })}</span>
                    <span title={b.reason}>{t("aside.confidence", { n: Math.round(b.confidence * 100) })}</span>
                  </span>
                  <span className="line-clamp-3 whitespace-pre-line break-words text-[13px] leading-snug text-body">
                    {asideText(b.text) || "—"}
                  </span>
                  <span className="flex flex-wrap gap-x-3 text-xs">
                    {onSource && (
                      <button
                        type="button"
                        className="font-semibold text-accent-text hover:underline"
                        onClick={() => {
                          onClose();
                          onSource(asideBoxes(b));
                        }}
                      >
                        {t("aside.showOnPdf")}
                      </button>
                    )}
                    <button type="button" className="font-semibold text-accent-text hover:underline" onClick={() => onReport(b)}>
                      {t("aside.wronglyHidden")}
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </dialog>
  );
}

const ERROR_LABEL: Record<ExtractionError, Key> = {
  missing_text: "report.missing_text",
  wrong_order: "report.wrong_order",
  metadata_in_body: "report.metadata_in_body",
  missing_media: "report.missing_media",
  ocr_error: "report.ocr_error",
  wrongly_hidden: "report.wrongly_hidden",
  other: "report.other",
};

/** What the report is about when it is opened from a hidden block. */
export type ReportPreset = { block: AsideBlock } | null;

/** CR-FR-15, SRS §6.1: "Báo lỗi trích xuất" — the kind of error, the page, a few words. */
export function ReportDialog({
  docId,
  open,
  preset,
  pageCount,
  onClose,
}: {
  docId: string;
  open: boolean;
  preset: ReportPreset;
  pageCount: number | null;
  onClose: () => void;
}) {
  const t = useT();
  const ref = useModal(open);
  const { showToast } = useUi();
  const report = useReportExtraction(docId);
  const [kind, setKind] = useState<ExtractionError>("missing_text");
  const [page, setPage] = useState("");
  const [note, setNote] = useState("");

  useEffect(() => {
    if (!open) return;
    report.reset();
    setKind(preset ? "wrongly_hidden" : "missing_text");
    setPage(preset ? String(preset.block.page) : "");
    setNote("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, preset]);

  const pageNumber = page.trim() ? Number(page) : null;
  const pageBad = pageNumber !== null && !(Number.isInteger(pageNumber) && pageNumber >= 1 && (!pageCount || pageNumber <= pageCount));

  function send() {
    if (pageBad) return;
    report.mutate(
      { error_type: kind, page: pageNumber, block: preset && kind === "wrongly_hidden" ? preset.block.id : null, note: note.trim() || null },
      {
        onSuccess: () => {
          showToast(t("report.sent"));
          onClose();
        },
      },
    );
  }

  const field = "rounded-lg border border-field bg-surface px-3 text-[15px] text-ink outline-none focus:border-focus";
  return (
    <dialog
      ref={ref}
      aria-label={t("report.title")}
      onCancel={(e) => {
        e.preventDefault();
        if (!report.isPending) onClose();
      }}
      onClick={(e) => e.target === e.currentTarget && !report.isPending && onClose()}
      className="dialog w-[min(calc(100vw-32px),460px)]"
    >
      <form
        className="flex flex-col gap-4 p-[26px]"
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        <div className="flex flex-col gap-1">
          <h2 className="font-serif text-2xl font-medium">{t("report.title")}</h2>
          <p className="text-[13px] leading-relaxed text-muted">{t("report.lede")}</p>
        </div>
        {preset && (
          <p className="rounded-lg bg-soft px-3 py-2 text-[13px] leading-snug text-body">
            <span className="font-semibold text-ink">{t(asideLabel(preset.block.type))}</span> ·{" "}
            {t("aside.page", { n: preset.block.page })}
            <span className="mt-1 line-clamp-2 block">{asideText(preset.block.text)}</span>
          </p>
        )}
        <fieldset className="flex flex-col gap-1.5">
          <legend className="mb-1.5 text-sm text-muted">{t("report.kind")}</legend>
          {EXTRACTION_ERRORS.filter((e) => e !== "wrongly_hidden" || preset).map((e) => (
            <label key={e} className="flex items-center gap-2.5 text-[15px] text-ink">
              <input type="radio" name="error_type" value={e} checked={kind === e} onChange={() => setKind(e)} className="accent-[var(--accent)]" />
              {t(ERROR_LABEL[e])}
            </label>
          ))}
        </fieldset>
        <label className="flex flex-col gap-1.5 text-sm text-muted">
          {t("report.page")}
          <input
            inputMode="numeric"
            value={page}
            onChange={(e) => setPage(e.target.value.replace(/[^\d]/g, ""))}
            className={`${field} h-11 w-28`}
            aria-invalid={pageBad}
            placeholder={pageCount ? `1–${pageCount}` : ""}
          />
        </label>
        <label className="flex flex-col gap-1.5 text-sm text-muted">
          {t("report.note")}
          <textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} rows={3} className={`${field} py-2`} />
        </label>
        {pageBad && <Alert>{t("report.pageBad")}</Alert>}
        {report.isError && <Alert>{report.error.message}</Alert>}
        <div className="flex justify-end gap-2.5">
          <button type="button" className="btn-outline" onClick={onClose} disabled={report.isPending}>
            {t("common.cancel")}
          </button>
          <button type="submit" className="btn-primary" disabled={report.isPending || pageBad}>
            {report.isPending ? t("common.working") : t("report.send")}
          </button>
        </div>
      </form>
    </dialog>
  );
}

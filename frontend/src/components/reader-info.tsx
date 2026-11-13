"use client";

import { useState } from "react";

import { KIND_LABEL, origin, relativeTime } from "@/lib/doc-view";
import { useLang, useT, type Key } from "@/lib/i18n";
import { useSummary } from "@/lib/summary";
import type { DocumentDetail } from "@/lib/types";

import { CitationDialog } from "./citation-dialog";
import { Icon } from "./icons";

/** The reader panel's first tab: what the open document is, a short summary of it, and the facts about it. */
export function ReaderInfo({
  doc,
  progress,
  onSummary,
}: {
  doc: DocumentDetail;
  /** How far the reader is right now, as the toolbar words it. */
  progress: string;
  /** Open the AI tab, where the summary is made and shown whole. */
  onSummary: () => void;
}) {
  const t = useT();
  const lang = useLang();
  const { data: summary } = useSummary(doc.id);
  const [editing, setEditing] = useState(false);

  const authors = (doc.citation?.authors ?? []).map((a) => (a.given ? `${a.given} ${a.family}` : a.family)).filter(Boolean);
  const from = origin(doc, lang);
  const length = [
    doc.page_count ? t("library.pages", { n: doc.page_count }) : "",
    doc.word_count ? t("library.words", { n: doc.word_count.toLocaleString(lang) }) : "",
    doc.reading_minutes ? t("library.minutes", { n: doc.reading_minutes }) : "",
  ]
    .filter(Boolean)
    .join(" · ");
  const facts: [Key, string][] = [
    ["library.infoType", KIND_LABEL[doc.file_type]],
    ["library.infoSource", from],
    ["library.infoPublished", [doc.citation?.container, doc.citation?.year].filter(Boolean).join(", ")],
    ["library.infoLength", length],
    ["library.infoAdded", relativeTime(doc.created_at, lang)],
    ["reader.infoProgress", progress],
    ["reader.infoLicense", doc.license ?? ""],
  ];

  return (
    <div className="flex min-h-full flex-col gap-6">
      <div className="flex flex-col gap-1.5">
        <h2 className="font-display text-[19px] font-semibold leading-snug text-ink">{doc.title}</h2>
        {doc.url ? (
          <a href={doc.url} target="_blank" rel="noopener noreferrer" className="self-start text-sm text-muted hover:text-ink hover:underline">
            {from}
          </a>
        ) : (
          <span className="break-words text-sm text-muted">{from}</span>
        )}
        {authors.length > 0 && (
          <span className="mt-2 flex items-center gap-2.5 text-sm text-body">
            <span aria-hidden className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-soft font-semibold text-ink">
              {authors[0].trim().charAt(0).toUpperCase()}
            </span>
            <span className="line-clamp-2 min-w-0">{authors.join(", ")}</span>
          </span>
        )}
      </div>

      <section className="flex flex-col gap-2">
        <h3 className="eyebrow">{t("reader.infoSummary").toLocaleUpperCase(lang)}</h3>
        {summary ? (
          <>
            <p className="text-[15px] leading-relaxed text-ink">{summary.conclusion || summary.key_points[0]}</p>
            <button type="button" onClick={onSummary} className="flex items-center gap-1 self-start text-[13px] font-medium text-accent-text hover:underline">
              {t("reader.fullSummary")}
              <Icon name="arrow" size={14} />
            </button>
          </>
        ) : (
          <>
            <p className="text-sm leading-relaxed text-muted">{t("reader.noSummary")}</p>
            <button type="button" onClick={onSummary} className="btn-outline h-10 self-start text-sm">
              <Icon name="spark" size={16} />
              {t("reader.makeSummary")}
            </button>
          </>
        )}
      </section>

      <section className="flex flex-col gap-2.5">
        <h3 className="eyebrow">{t("reader.infoDetails").toLocaleUpperCase(lang)}</h3>
        <dl className="grid grid-cols-[92px_minmax(0,1fr)] gap-x-3 gap-y-2.5 text-sm">
          {facts
            .filter(([, value]) => value)
            .map(([label, value]) => (
              <div key={label} className="contents">
                <dt className="text-muted">{t(label)}</dt>
                <dd className="min-w-0 break-words text-ink">{value}</dd>
              </div>
            ))}
        </dl>
      </section>

      <span className="flex-1" />
      <button
        type="button"
        onClick={() => setEditing(true)}
        className="-mx-4 -mb-4 flex h-12 items-center gap-2 border-t border-line px-4 text-sm font-medium text-ink hover:bg-soft"
      >
        <Icon name="pencil" size={16} />
        {t("reader.editMeta")}
      </button>

      <CitationDialog doc={editing ? doc : null} onClose={() => setEditing(false)} />
    </div>
  );
}

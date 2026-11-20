"use client";

import Link from "next/link";

import { Icon } from "@/components/icons";
import { categoryLabel } from "@/lib/annotations";
import { KIND_CLASS, KIND_LABEL } from "@/lib/doc-view";
import { useLang, useT } from "@/lib/i18n";
import type { NotebookSource, SourceGroup } from "@/lib/notebooks";

const readerLink = (s: NotebookSource) => `/reader/${s.highlight.document_id}?hl=${s.highlight.id}`;

function Position({ n }: { n: number }) {
  return (
    <span className="mt-0.5 flex h-6 min-w-6 shrink-0 items-center justify-center rounded bg-accent/15 px-1 font-sans text-xs font-semibold text-accent-text">
      {n}
    </span>
  );
}

function KindBadge({ group }: { group: SourceGroup }) {
  return (
    <span className={`flex h-6 w-11 shrink-0 items-center justify-center rounded-[5px] text-[11px] font-bold ${KIND_CLASS[group.fileType]}`}>
      {KIND_LABEL[group.fileType]}
    </span>
  );
}

function RemoveButton({ source, onRemove, busy }: { source: NotebookSource; onRemove: () => void; busy: boolean }) {
  const t = useT();
  return (
    <button
      type="button"
      className="icon-btn -mr-1.5 -mt-1.5 h-8 w-8 text-muted max-md:-mr-2.5 max-md:-mt-2.5 max-md:h-11 max-md:w-11"
      aria-label={t("nb.dropSource", { n: source.position })}
      title={t("nb.dropSourceTitle")}
      onClick={onRemove}
      disabled={busy}
    >
      <Icon name="x" size={16} />
    </button>
  );
}

/** Category and page of a source, e.g. "Khái niệm · trang 12". */
function useWhere() {
  const t = useT();
  const lang = useLang();
  return (s: NotebookSource) =>
    [
      s.highlight.category && categoryLabel(s.highlight.category, lang),
      s.highlight.page_number && t("search.pageOf", { page: s.highlight.page_number }),
    ]
      .filter(Boolean)
      .join(" · ");
}

/** The notebook's side panel: its sources under the document each comes from; a document can be folded. */
export function SourceGroups({
  groups,
  onRemove,
  onInsert,
  busy,
}: {
  groups: SourceGroup[];
  onRemove: (source: NotebookSource) => void;
  /** Quotes the passage into the notes, with its [n]. */
  onInsert?: (source: NotebookSource) => void;
  busy: boolean;
}) {
  const t = useT();
  const where = useWhere();
  return (
    <div className="flex flex-col gap-3">
      {groups.map((g) => (
        <details key={g.documentId} open className="group rounded-xl border border-line bg-surface">
          <summary className="flex cursor-pointer list-none items-center gap-2.5 rounded-xl p-3 hover:bg-soft/60 [&::-webkit-details-marker]:hidden">
            <KindBadge group={g} />
            <span className="min-w-0 flex-1 truncate text-sm font-semibold text-ink" title={g.title}>
              {g.title}
            </span>
            <span className="text-xs text-muted">{g.sources.length}</span>
            <Icon name="next" size={16} className="shrink-0 text-muted transition-transform group-open:rotate-90" />
          </summary>
          <ul className="flex flex-col border-t border-line">
            {g.sources.map((s) => (
              <li key={s.highlight.id} id={`source-${s.position}`} className="flex gap-2.5 border-b border-line p-3 last:border-b-0">
                <Position n={s.position} />
                <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                  <span className="line-clamp-3 font-serif text-[15px] leading-snug text-ink">
                    <span className={`box-decoration-clone hl-bg-${s.highlight.color}`}>{s.highlight.selected_text}</span>
                  </span>
                  <span className="flex flex-wrap items-center gap-x-2 text-xs text-muted">
                    {where(s)}
                    <Link href={readerLink(s)} className="font-semibold text-accent-text hover:underline max-md:inline-flex max-md:h-11 max-md:items-center">
                      {t("nb.openInDocument")}
                    </Link>
                    {onInsert && (
                      <button type="button" className="font-semibold text-accent-text hover:underline max-md:h-11" onClick={() => onInsert(s)}>
                        {t("nb.quoteIntoNotes")}
                      </button>
                    )}
                  </span>
                </div>
                <RemoveButton source={s} onRemove={() => onRemove(s)} busy={busy} />
              </li>
            ))}
          </ul>
        </details>
      ))}
    </div>
  );
}

/**
 * The notebook's highlights in full, document by document, each with its [n] and the reader's note.
 * `onRemove` is left out on paper (the printed appendix), where nothing can be clicked.
 */
export function HighlightDigest({
  groups,
  onRemove,
  busy = false,
}: {
  groups: SourceGroup[];
  onRemove?: (source: NotebookSource) => void;
  busy?: boolean;
}) {
  const t = useT();
  const where = useWhere();
  return (
    <div className="flex flex-col gap-9">
      {groups.map((g) => (
        <section key={g.documentId} aria-label={g.title}>
          <header className="flex break-after-avoid flex-wrap items-center gap-x-2.5 gap-y-1 border-b border-line pb-2.5">
            <KindBadge group={g} />
            <h3 className="min-w-0 flex-1 basis-[220px] font-serif text-xl font-medium leading-snug text-ink">{g.title}</h3>
            <span className="text-[13px] text-muted">{t("nb.groupCount", { n: g.sources.length })}</span>
            {onRemove && (
              <Link href={`/reader/${g.documentId}`} className="btn-ghost h-9 px-3 text-sm max-md:h-11">
                {t("nb.openDocument")}
              </Link>
            )}
          </header>
          <ol className="flex flex-col">
            {g.sources.map((s) => (
              <li key={s.highlight.id} className="flex break-inside-avoid gap-3 border-b border-line py-4 last:border-b-0">
                <Position n={s.position} />
                <div className="flex min-w-0 flex-1 flex-col gap-2">
                  <p className="whitespace-pre-line font-serif text-[17px] leading-relaxed text-ink">
                    <span className={`box-decoration-clone hl-bg-${s.highlight.color}`}>{s.highlight.selected_text}</span>
                  </p>
                  {s.highlight.note.trim() && (
                    <p className="whitespace-pre-wrap rounded-lg bg-soft px-3 py-2.5 text-sm leading-normal text-body">
                      {t("picker.notePrefix", { note: s.highlight.note.trim() })}
                    </p>
                  )}
                  <span className="flex flex-wrap items-center gap-x-2 text-[13px] text-muted">
                    {where(s)}
                    {onRemove && (
                      <Link href={readerLink(s)} className="font-semibold text-accent-text hover:underline max-md:inline-flex max-md:h-11 max-md:items-center">
                        {t("nb.openInDocument")}
                      </Link>
                    )}
                  </span>
                </div>
                {onRemove && <RemoveButton source={s} onRemove={() => onRemove(s)} busy={busy} />}
              </li>
            ))}
          </ol>
        </section>
      ))}
    </div>
  );
}

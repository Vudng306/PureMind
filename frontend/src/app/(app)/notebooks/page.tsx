"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { Icon } from "@/components/icons";
import { Alert, PageHeader, Spinner } from "@/components/ui";
import { KIND_CLASS, KIND_LABEL, relativeTime } from "@/lib/doc-view";
import { useLang, useT } from "@/lib/i18n";
import { useCollections } from "@/lib/library";
import { MSG } from "@/lib/messages";
import { readingState, useNotebookGroups, type NotebookGroup } from "@/lib/notebook";
import { useNotebooks } from "@/lib/notebooks";

const SEARCH_DELAY = 300;

function GroupCard({ g, searching }: { g: NotebookGroup; searching: boolean }) {
  const t = useT();
  const lang = useLang();
  const state = readingState(g);
  const counts: [string, string][] = [
    ["highlighter", t("notebook.nHighlights", { n: g.highlight_count })],
    ["note", t("notebook.nNotes", { n: g.note_count })],
    ...(g.insight_count > 0 ? ([["spark", t("notebook.nInsights", { n: g.insight_count })]] as [string, string][]) : []),
  ];
  return (
    <li>
      <Link
        href={`/notebooks/doc/${g.document_id}`}
        className="card group flex h-full min-h-[176px] flex-col gap-3 p-5 transition-[box-shadow,transform] hover:-translate-y-0.5 hover:shadow-float"
      >
        <span className="flex flex-wrap items-center gap-1.5">
          <span className={`flex h-6 w-11 items-center justify-center rounded-[5px] text-[11px] font-bold ${KIND_CLASS[g.file_type]}`}>
            {KIND_LABEL[g.file_type]}
          </span>
          <span
            className={`flex h-6 items-center rounded-full px-2 text-xs font-medium ${
              state === "read" ? "bg-success-soft text-success" : "bg-soft text-ink"
            }`}
          >
            {state === "read"
              ? t("notebook.read")
              : state === "reading"
                ? t("notebook.reading", { n: Math.round((g.read_fraction ?? 0) * 100) })
                : t("notebook.unread")}
          </span>
          {searching && g.match_count !== null && g.match_count > 0 && (
            <span className="flex h-6 items-center rounded-full bg-accent-soft px-2 text-xs font-semibold text-accent-on-soft">
              {t("notebook.nMatches", { n: g.match_count })}
            </span>
          )}
        </span>
        <span className="line-clamp-3 font-display text-[20px] font-semibold leading-snug text-ink">{g.title}</span>
        <span className="mt-auto flex flex-wrap items-center gap-x-3.5 gap-y-1 text-[13px] text-body">
          {counts.map(([icon, label]) => (
            <span key={icon} className="flex items-center gap-1.5">
              <Icon name={icon as "note"} size={15} className="text-muted" />
              {label}
            </span>
          ))}
        </span>
        <span className="flex items-center gap-2 border-t border-line pt-3 text-[13px] text-muted">
          <span className="min-w-0 flex-1 truncate">{t("notebook.updated", { when: relativeTime(g.last_activity_at, lang) })}</span>
          <Icon name="arrow" size={16} className="shrink-0 transition-transform group-hover:translate-x-0.5" />
        </span>
      </Link>
    </li>
  );
}

/**
 * The Notebook: what the reader marked and wrote, one group per document. A document appears here with its
 * first highlight, note, or thing kept from the AI; nothing the AI writes arrives on its own.
 */
export default function NotebookPage() {
  const t = useT();
  const [text, setText] = useState("");
  const [q, setQ] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setQ(text.trim()), SEARCH_DELAY);
    return () => clearTimeout(timer);
  }, [text]);

  const query = useNotebookGroups(q);
  const { data: old } = useNotebooks();
  // An AI notebook is made from one document (on its page) or by topic from one collection: only the latter here.
  const { data: shelves } = useCollections();
  const hasShelf = (shelves ?? []).some((c) => c.document_count > 0);
  const items = query.data?.items ?? [];
  const searching = q.length >= 2;
  const empty = query.isSuccess && items.length === 0;

  return (
    <div className="mx-auto flex max-w-[1040px] flex-col gap-7">
      <PageHeader
        title={t("notebooks.title")}
        lead={query.isSuccess && !searching && items.length ? t("notebook.count", { n: query.data.total }) : t("notebook.lede")}
        actions={
          query.isSuccess && hasShelf && (items.length > 0 || searching) ? (
            <Link href="/notebooks/new?from=notebook" className="btn-outline">
              <Icon name="spark" size={16} />
              {t("notebooks.byCollection")}
            </Link>
          ) : undefined
        }
      />

      {(!empty || searching || text) && !query.isError && (
        <label className="relative block max-w-[480px]">
          <span className="sr-only">{t("notebook.searchAria")}</span>
          <Icon name="search" size={18} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-muted" />
          <input
            type="search"
            value={text}
            maxLength={200}
            onChange={(e) => setText(e.target.value)}
            placeholder={t("notebook.searchPlaceholder")}
            className="input h-11 pl-10"
          />
        </label>
      )}

      {query.isPending ? (
        <Spinner />
      ) : query.isError ? (
        <div className="flex flex-col items-start gap-3">
          <Alert>{query.error instanceof Error ? query.error.message : MSG["MSG-99"]}</Alert>
          <button type="button" className="btn-outline" onClick={() => void query.refetch()}>
            {t("common.retry")}
          </button>
        </div>
      ) : empty && searching ? (
        <p className="py-8 text-[15px] text-muted">{t("notebook.noMatch", { q })}</p>
      ) : empty ? (
        <div className="flex flex-col items-center gap-3.5 rounded-[22px] border-2 border-dashed border-field bg-surface/60 px-6 py-16 text-center">
          <span aria-hidden className="grid h-14 w-14 place-items-center rounded-2xl bg-accent-soft text-accent-text">
            <Icon name="note" size={26} />
          </span>
          <span className="font-display text-[28px] font-semibold">{t("notebook.emptyTitle")}</span>
          <span className="max-w-md text-[15px] leading-relaxed text-muted">{t("notebook.emptyBody")}</span>
          <Link href="/library" className="btn-primary">
            <Icon name="book" size={16} />
            {t("notebook.toLibrary")}
          </Link>
        </div>
      ) : (
        <ul className={`grid gap-5 sm:grid-cols-2 lg:grid-cols-3 ${query.isPlaceholderData ? "opacity-60" : ""}`}>
          {items.map((g) => (
            <GroupCard key={g.document_id} g={g} searching={searching} />
          ))}
        </ul>
      )}

      {(old?.length ?? 0) > 0 && (
        <Link href="/notebooks/archive" className="flex items-center gap-2 self-start text-sm text-muted hover:text-ink">
          <Icon name="history" size={16} />
          {t("notebook.archiveLink", { n: old?.length ?? 0 })}
        </Link>
      )}
    </div>
  );
}

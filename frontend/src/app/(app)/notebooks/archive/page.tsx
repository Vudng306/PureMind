"use client";

import Link from "next/link";
import { useState } from "react";

import { Icon } from "@/components/icons";
import { Alert, PageHeader, Spinner } from "@/components/ui";
import { relativeTime } from "@/lib/doc-view";
import { useLang, useMsg, useT } from "@/lib/i18n";
import { MSG } from "@/lib/messages";
import {
  STATUS_LABEL,
  useNotebooks,
  type NotebookStatus,
} from "@/lib/notebooks";
import { toneOf } from "@/lib/tone";

const FILTERS = [
  ["", "common.all"],
  ["draft", STATUS_LABEL.draft],
  ["saved", STATUS_LABEL.saved],
] as const;

/**
 * The notebooks written before the Notebook became the reader's highlights and notes by document: syntheses
 * the AI wrote from chosen highlights, and blank ones written by hand. They stay readable and editable here.
 */
export default function NotebookArchivePage() {
  const t = useT();
  const msg = useMsg();
  const lang = useLang();
  const query = useNotebooks();
  const [status, setStatus] = useState<NotebookStatus | "">("");
  const [topic, setTopic] = useState("");
  const items = query.data ?? [];
  const mixed = items.some((nb) => nb.status === "draft") && items.some((nb) => nb.status === "saved");
  const topics = [...new Set(items.flatMap((nb) => (nb.topic ? [nb.topic] : [])))].sort((a, b) => a.localeCompare(b, lang));
  const shown = items
    .filter((nb) => !mixed || !status || nb.status === status)
    .filter((nb) => !topic || nb.topic === topic);

  return (
    <div className="mx-auto flex max-w-[1040px] flex-col gap-7">
      <Link href="/notebooks" className="-mb-3 flex items-center gap-1.5 self-start text-sm text-muted hover:text-ink">
        <Icon name="back" size={16} />
        {t("notebooks.title")}
      </Link>
      <PageHeader
        title={t("notebooks.archiveTitle")}
        lead={t("notebooks.archiveLede")}
      />

      {query.isPending ? (
        <Spinner />
      ) : query.isError ? (
        <div className="flex flex-col items-start gap-3">
          <Alert>{query.error instanceof Error ? query.error.message : MSG["MSG-99"]}</Alert>
          <button type="button" className="btn-outline" onClick={() => query.refetch()}>
            {t("common.retry")}
          </button>
        </div>
      ) : items.length === 0 ? (
        <div className="flex flex-col items-center gap-3.5 rounded-[22px] border-2 border-dashed border-field bg-surface/60 px-6 py-16 text-center">
          <span aria-hidden className="grid h-14 w-14 place-items-center rounded-2xl bg-accent-soft text-accent-text">
            <Icon name="note" size={26} />
          </span>
          <span className="font-display text-[28px] font-semibold">{msg("MSG-35")}</span>
          <span className="max-w-md text-[15px] text-muted">{t("notebooks.archiveEmpty")}</span>
        </div>
      ) : (
        <>
          {(mixed || topics.length > 0) && (
            <div className="flex flex-wrap items-center gap-2.5">
              {mixed && (
                <div className="segmented">
                  {FILTERS.map(([value, label]) => (
                    <button key={value} type="button" aria-pressed={status === value} onClick={() => setStatus(value)}>
                      {t(label)}
                    </button>
                  ))}
                </div>
              )}
              {topics.length > 0 && (
                <div role="group" aria-label={t("nb.topicLabel")} className="flex flex-wrap items-center gap-1.5">
                  <button type="button" className="chip" aria-pressed={topic === ""} onClick={() => setTopic("")}>
                    {t("notebooks.allTopics")}
                  </button>
                  {topics.map((x) => (
                    <button key={x} type="button" className="chip" aria-pressed={topic === x} onClick={() => setTopic(x)}>
                      {x}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          <ul className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {shown.map((nb) => (
              <li key={nb.id}>
                <Link
                  href={`/notebooks/${nb.id}`}
                  className={`card group relative flex h-full min-h-[200px] flex-col gap-3.5 overflow-hidden p-5 pt-6 transition-[box-shadow,transform] hover:-translate-y-0.5 hover:shadow-float ${toneOf(nb.title)}`}
                >
                  <span aria-hidden className="absolute inset-x-0 top-0 h-1.5 bg-tone" />
                  <span className="flex flex-wrap items-center gap-1.5">
                    <span
                      className={`flex h-6 items-center rounded-full px-2 text-xs font-semibold ${
                        nb.status === "saved" ? "bg-success-soft text-success" : "bg-soft text-ink"
                      }`}
                    >
                      {t(STATUS_LABEL[nb.status])}
                    </span>
                    {nb.topic && <span className="flex h-6 items-center rounded-full bg-soft px-2 text-xs text-ink">{nb.topic}</span>}
                  </span>
                  <span className="line-clamp-3 font-display text-[21px] font-semibold leading-snug text-ink">{nb.title}</span>
                  <span className="mt-auto flex items-center gap-2 border-t border-line pt-3.5 text-[13px] text-muted">
                    <Icon name="highlighter" size={16} className="shrink-0" />
                    <span className="min-w-0 flex-1 truncate">
                      {t("notebooks.sourcesUpdated", { n: nb.source_count, when: relativeTime(nb.updated_at, lang) })}
                    </span>
                    <Icon name="arrow" size={16} className="shrink-0 transition-transform group-hover:translate-x-0.5" />
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}
      {items.some((nb) => nb.status === "draft") && <p className="text-xs text-muted">{t("notebooks.draftNotice")}</p>}
    </div>
  );
}

"use client";

import Link from "next/link";
import { useState } from "react";

import { Icon } from "@/components/icons";
import { NotebookCard } from "@/components/notebook-card";
import { Alert, PageHeader, Spinner } from "@/components/ui";
import { useLang, useMsg, useT } from "@/lib/i18n";
import { MSG } from "@/lib/messages";
import {
  STATUS_LABEL,
  useNotebooks,
  type NotebookStatus,
} from "@/lib/notebooks";

const FILTERS = [
  ["", "common.all"],
  ["draft", STATUS_LABEL.draft],
  ["saved", STATUS_LABEL.saved],
] as const;

/** Every AI notebook (and the hand-written ones made before), newest first, by state and topic. */
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
      <Link href="/notebooks" className="-mb-3 flex items-center gap-1.5 self-start text-sm text-muted hover:text-ink max-md:-mt-3 max-md:h-11 max-md:pr-3">
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
              <NotebookCard key={nb.id} nb={nb} />
            ))}
          </ul>
        </>
      )}
      {items.some((nb) => nb.status === "draft") && <p className="text-xs text-muted">{t("notebooks.draftNotice")}</p>}
    </div>
  );
}

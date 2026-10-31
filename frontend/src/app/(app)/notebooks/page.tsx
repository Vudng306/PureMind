"use client";

import Link from "next/link";
import { useState } from "react";

import { Icon } from "@/components/icons";
import { Alert, Spinner } from "@/components/ui";
import { relativeTime } from "@/lib/doc-view";
import { useLang, useMsg, useT } from "@/lib/i18n";
import { MSG } from "@/lib/messages";
import { STATUS_LABEL, useNotebooks, type NotebookStatus } from "@/lib/notebooks";

const FILTERS = [
  ["", "common.all"],
  ["draft", STATUS_LABEL.draft],
  ["saved", STATUS_LABEL.saved],
] as const;

/** UI-06, FR-NB-05: the user's notebooks, most recently updated first. */
export default function NotebooksPage() {
  const t = useT();
  const msg = useMsg();
  const lang = useLang();
  const query = useNotebooks();
  const [status, setStatus] = useState<NotebookStatus | "">("");
  const items = query.data ?? [];
  const mixed = items.some((nb) => nb.status === "draft") && items.some((nb) => nb.status === "saved");
  const shown = mixed && status ? items.filter((nb) => nb.status === status) : items;

  return (
    <div className="mx-auto flex max-w-[1040px] flex-col gap-7">
      <div className="flex flex-wrap items-end gap-4">
        <div className="flex min-w-0 flex-1 basis-60 flex-col gap-2">
          <h1 className="font-serif text-4xl font-medium leading-[1.1] sm:text-5xl">{t("notebooks.title")}</h1>
          <p className="text-base text-muted">
            {query.isSuccess && items.length
              ? t("notebooks.count", { n: items.length })
              : t("notebooks.lede")}
          </p>
        </div>
        <Link href="/notebooks/new" className="btn-primary">
          <Icon name="spark" size={16} />
          {t("notebooks.generate")}
        </Link>
      </div>

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
        <div className="flex flex-col items-center gap-3.5 rounded-[14px] border border-dashed border-field px-6 py-16 text-center">
          <span className="font-serif text-[28px]">{msg("MSG-35")}</span>
          <span className="max-w-md text-[15px] text-muted">
            {t("notebooks.emptyLong")}
          </span>
          <Link href="/notebooks/new" className="btn-primary">
            {t("notebooks.first")}
          </Link>
        </div>
      ) : (
        <>
          {mixed && (
            <div className="flex flex-wrap gap-1.5">
              {FILTERS.map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  className="chip h-9 px-3.5 text-[13px]"
                  aria-pressed={status === value}
                  onClick={() => setStatus(value)}
                >
                  {t(label)}
                </button>
              ))}
            </div>
          )}
          <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {shown.map((nb) => (
              <li key={nb.id}>
                <Link
                  href={`/notebooks/${nb.id}`}
                  className="group flex h-full min-h-[190px] flex-col gap-3.5 rounded-2xl border border-line bg-surface p-5 transition-shadow hover:shadow-float"
                >
                  <span
                    className={`flex h-6 items-center self-start rounded-full px-2 text-xs font-semibold ${
                      nb.status === "saved" ? "bg-success-soft text-success" : "bg-soft text-ink"
                    }`}
                  >
                    {t(STATUS_LABEL[nb.status])}
                  </span>
                  <span className="line-clamp-3 font-serif text-[21px] font-medium leading-snug text-ink">{nb.title}</span>
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
      {items.some((nb) => nb.status === "draft") && (
        <p className="text-xs text-muted">{t("notebooks.draftNotice")}</p>
      )}
    </div>
  );
}

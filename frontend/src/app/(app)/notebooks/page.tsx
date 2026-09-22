"use client";

import Link from "next/link";

import { Icon } from "@/components/icons";
import { Alert, Spinner } from "@/components/ui";
import { relativeTime } from "@/lib/doc-view";
import { useLang, useMsg, useT } from "@/lib/i18n";
import { MSG } from "@/lib/messages";
import { STATUS_LABEL, useNotebooks } from "@/lib/notebooks";

/** UI-06, FR-NB-05: the user's notebooks, most recently updated first. */
export default function NotebooksPage() {
  const t = useT();
  const msg = useMsg();
  const lang = useLang();
  const query = useNotebooks();
  const items = query.data ?? [];

  return (
    <div className="mx-auto flex max-w-[880px] flex-col gap-7">
      <div className="flex flex-wrap items-end gap-4">
        <div className="flex min-w-0 flex-1 flex-col gap-2">
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
        <ul className="flex flex-col gap-3">
          {items.map((nb) => (
            <li key={nb.id}>
              <Link
                href={`/notebooks/${nb.id}`}
                className="flex items-center gap-4 rounded-xl border border-line bg-surface p-4 transition-shadow hover:shadow-float sm:p-5"
              >
                <span className="flex min-w-0 flex-1 flex-col gap-1.5">
                  <span className="truncate font-serif text-[19px] font-medium text-ink">{nb.title}</span>
                  <span className="flex flex-wrap items-center gap-2 text-[13px] text-muted">
                    <span
                      className={`flex h-6 items-center rounded-full px-2 text-xs font-semibold ${
                        nb.status === "saved" ? "bg-success-soft text-success" : "bg-soft text-ink"
                      }`}
                    >
                      {t(STATUS_LABEL[nb.status])}
                    </span>
                    {t("notebooks.sourcesUpdated", { n: nb.source_count, when: relativeTime(nb.updated_at, lang) })}
                  </span>
                </span>
                <Icon name="next" className="shrink-0 text-muted" />
              </Link>
            </li>
          ))}
        </ul>
      )}
      {items.some((nb) => nb.status === "draft") && (
        <p className="text-xs text-muted">{t("notebooks.draftNotice")}</p>
      )}
    </div>
  );
}

"use client";

import Link from "next/link";

import { Icon } from "@/components/icons";
import { relativeTime } from "@/lib/doc-view";
import { useLang, useT } from "@/lib/i18n";
import { STATUS_LABEL, type NotebookListItem } from "@/lib/notebooks";
import { toneOf } from "@/lib/tone";

/** One AI notebook in a list: its state, topic, title, and how many passages it cites. */
export function NotebookCard({ nb }: { nb: NotebookListItem }) {
  const t = useT();
  const lang = useLang();
  return (
    <li>
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
  );
}

"use client";

import { useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { Icon } from "@/components/icons";
import { Alert, PageHeader, Spinner, useModal } from "@/components/ui";
import { relativeTime } from "@/lib/doc-view";
import { useLang, useMsg, useT } from "@/lib/i18n";
import { MSG } from "@/lib/messages";
import {
  MAX_NOTEBOOK_TITLE,
  MAX_NOTEBOOK_TOPIC,
  STATUS_LABEL,
  createNotebook,
  notebooksKey,
  useNotebooks,
  type NotebookStatus,
} from "@/lib/notebooks";
import { toneOf } from "@/lib/tone";

const FILTERS = [
  ["", "common.all"],
  ["draft", STATUS_LABEL.draft],
  ["saved", STATUS_LABEL.saved],
] as const;

/** A blank notebook, for writing by hand. No AI runs and nothing is spent. */
function NewNotebookDialog({ open, topics, onClose }: { open: boolean; topics: string[]; onClose: () => void }) {
  const t = useT();
  const router = useRouter();
  const qc = useQueryClient();
  const ref = useModal(open);
  const [title, setTitle] = useState("");
  const [topic, setTopic] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setTitle("");
      setTopic("");
      setError(null);
    }
  }, [open]);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const nb = await createNotebook({ title: title.trim(), topic: topic.trim() || undefined });
      void qc.invalidateQueries({ queryKey: notebooksKey });
      onClose();
      router.push(`/notebooks/${nb.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : MSG["MSG-99"]);
    } finally {
      setBusy(false);
    }
  }

  const field = "h-11 rounded-lg border border-field bg-surface px-3 text-[15px] text-ink outline-none focus:border-focus";

  return (
    <dialog
      ref={ref}
      aria-label={t("notebooks.new")}
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onClose();
      }}
      className="dialog w-[min(calc(100vw-32px),480px)]"
    >
      <form className="flex flex-col gap-3.5 p-[26px]" onSubmit={(e) => void create(e)}>
        <h2 className="font-serif text-2xl font-medium">{t("notebooks.new")}</h2>
        <label className="flex flex-col gap-1.5">
          <span className="text-sm text-muted">{t("nb.titleLabel")}</span>
          <input value={title} maxLength={MAX_NOTEBOOK_TITLE} onChange={(e) => setTitle(e.target.value)} className={field} />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-sm text-muted">{t("nb.topicLabel")}</span>
          <input
            value={topic}
            list="notebook-topics"
            maxLength={MAX_NOTEBOOK_TOPIC}
            placeholder={t("nb.topicPlaceholder")}
            onChange={(e) => setTopic(e.target.value)}
            className={field}
          />
          <datalist id="notebook-topics">
            {topics.map((x) => (
              <option key={x} value={x} />
            ))}
          </datalist>
        </label>
        {error && <Alert>{error}</Alert>}
        <div className="mt-1.5 flex justify-end gap-2.5">
          <button type="button" className="btn-outline" onClick={onClose} disabled={busy}>
            {t("common.cancel")}
          </button>
          <button type="submit" className="btn-primary" disabled={!title.trim() || busy}>
            {t(busy ? "common.working" : "notebooks.create")}
          </button>
        </div>
      </form>
    </dialog>
  );
}

/** UI-06, FR-NB-05: the user's notebooks by topic or project, most recently updated first. */
export default function NotebooksPage() {
  const t = useT();
  const msg = useMsg();
  const lang = useLang();
  const query = useNotebooks();
  const [status, setStatus] = useState<NotebookStatus | "">("");
  const [topic, setTopic] = useState("");
  const [creating, setCreating] = useState(false);
  const items = query.data ?? [];
  const mixed = items.some((nb) => nb.status === "draft") && items.some((nb) => nb.status === "saved");
  const topics = [...new Set(items.flatMap((nb) => (nb.topic ? [nb.topic] : [])))].sort((a, b) => a.localeCompare(b, lang));
  const shown = items
    .filter((nb) => !mixed || !status || nb.status === status)
    .filter((nb) => !topic || nb.topic === topic);

  return (
    <div className="mx-auto flex max-w-[1040px] flex-col gap-7">
      <PageHeader
        title={t("notebooks.title")}
        lead={query.isSuccess && items.length ? t("notebooks.count", { n: items.length }) : t("notebooks.lede")}
        actions={
          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn-primary" onClick={() => setCreating(true)}>
              <Icon name="plus" size={16} />
              {t("notebooks.new")}
            </button>
            <Link href="/notebooks/new" className="btn-outline">
              <Icon name="spark" size={16} />
              {t("notebooks.fromHighlights")}
            </Link>
          </div>
        }
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
          <span className="max-w-md text-[15px] text-muted">{t("notebooks.emptyLong")}</span>
          <div className="flex flex-wrap justify-center gap-2.5">
            <button type="button" className="btn-primary" onClick={() => setCreating(true)}>
              {t("notebooks.new")}
            </button>
            <Link href="/notebooks/new" className="btn-outline">
              {t("notebooks.first")}
            </Link>
          </div>
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
      <NewNotebookDialog open={creating} topics={topics} onClose={() => setCreating(false)} />
    </div>
  );
}

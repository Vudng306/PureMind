"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useMemo, useState } from "react";

import { NoteCard, NoteComposer } from "@/components/doc-notes";
import { Icon } from "@/components/icons";
import { HighlightCard } from "@/components/reader-panel";
import { Alert, Spinner } from "@/components/ui";
import { useHighlights } from "@/lib/annotations";
import { ApiError } from "@/lib/api";
import type { ChatCitation } from "@/lib/chat";
import { KIND_CLASS, KIND_LABEL, relativeTime } from "@/lib/doc-view";
import { useDocument } from "@/lib/documents";
import { downloadText, exportFileName } from "@/lib/export";
import { useLang, useT, type Key } from "@/lib/i18n";
import { MSG } from "@/lib/messages";
import {
  inOrder,
  matchesQuery,
  notebookMarkdown,
  readingState,
  useNotebookDocument,
  type NotebookSort,
} from "@/lib/notebook";
import { splitNotes, useNotes } from "@/lib/notes";
import { usePreferences } from "@/lib/preferences";
import { findSnippet } from "@/lib/reader-ai";
import { useUi } from "@/lib/ui-store";

type Filter = "all" | "highlights" | "notes" | "ai";
const FILTERS: [Filter, Key][] = [
  ["all", "common.all"],
  ["highlights", "notebook.filterHighlights"],
  ["notes", "notebook.filterNotes"],
  ["ai", "notebook.filterAi"],
];
const SORTS: [NotebookSort, Key][] = [
  ["document", "notebook.sortDocument"],
  ["newest", "notebook.sortNewest"],
];

function Section({ title, count, action, children }: { title: string; count: number; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center gap-2.5">
        <h2 className="font-display text-[21px] font-semibold text-ink">{title}</h2>
        <span className="rounded-md bg-soft px-1.5 py-px text-xs font-medium tabular-nums text-body">{count}</span>
        <span className="flex-1" />
        {action}
      </div>
      {children}
    </section>
  );
}

/** One document's page of the Notebook: its highlights with their notes, the free notes, and what was kept
 * from the AI. Everything here is the same data the reader shows, so an edit in one place is an edit in both. */
export default function NotebookDocumentPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const t = useT();
  const lang = useLang();
  const labels = usePreferences((s) => s.colorLabels);
  const showToast = useUi((s) => s.showToast);
  const [sort, setSort] = useState<NotebookSort>("document");
  const [filter, setFilter] = useState<Filter>("all");
  const [text, setText] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);

  const detail = useNotebookDocument(id, sort);
  const { data: doc } = useDocument(id);
  const liveHighlights = useHighlights(id);
  const liveNotes = useNotes(id);

  const highlights = useMemo(
    () => inOrder(detail.data?.highlights ?? [], liveHighlights.isSuccess ? liveHighlights.data : undefined),
    [detail.data, liveHighlights.isSuccess, liveHighlights.data],
  );
  const notes = useMemo(() => inOrder(detail.data?.notes ?? [], liveNotes.data), [detail.data, liveNotes.data]);
  const { own, ai } = splitNotes(notes);

  const q = text.trim();
  const shownHighlights = highlights.filter(
    (h) => (filter === "all" || filter === "highlights" || (filter === "notes" && h.note.trim())) && matchesQuery(`${h.text} ${h.note}`, q),
  );
  const shownOwn = filter === "all" || filter === "notes" ? own.filter((n) => matchesQuery(n.body, q)) : [];
  const shownAi = filter === "all" || filter === "ai" ? ai.filter((n) => matchesQuery(n.body, q)) : [];
  const nothingShown = shownHighlights.length + shownOwn.length + shownAi.length === 0;

  const back = (
    <Link href="/notebooks" className="flex items-center gap-1.5 self-start text-sm text-muted hover:text-ink max-md:-my-3 max-md:h-11 max-md:pr-3">
      <Icon name="back" size={16} />
      {t("notebooks.title")}
    </Link>
  );

  if (detail.isPending) {
    return (
      <div className="mx-auto flex max-w-[820px] flex-col gap-6">
        {back}
        <Spinner />
      </div>
    );
  }

  const missing = detail.error instanceof ApiError && detail.error.status === 404;
  if (detail.isError && !missing && !detail.data) {
    return (
      <div className="mx-auto flex max-w-[820px] flex-col items-start gap-4">
        {back}
        <Alert>{detail.error instanceof Error ? detail.error.message : MSG["MSG-99"]}</Alert>
        <button type="button" className="btn-outline" onClick={() => void detail.refetch()}>
          {t("common.retry")}
        </button>
      </div>
    );
  }

  const group = detail.data?.group;
  const empty = highlights.length === 0 && notes.length === 0;
  if (!group || empty) {
    // Nothing marked or written yet (or the last of it was just deleted): the document is not in the notebook.
    return (
      <div className="mx-auto flex max-w-[820px] flex-col gap-6">
        {back}
        <div className="flex flex-col items-center gap-3.5 rounded-[22px] border-2 border-dashed border-field bg-surface/60 px-6 py-14 text-center">
          <span className="font-display text-[24px] font-semibold">{t("notebook.docEmptyTitle")}</span>
          <span className="max-w-md text-[15px] leading-relaxed text-muted">{t("notebook.docEmptyBody")}</span>
          <Link href={`/reader/${id}`} className="btn-primary">
            <Icon name="book" size={16} />
            {t("notebook.openDocument")}
          </Link>
        </div>
      </div>
    );
  }

  const state = readingState(group);
  const noted = highlights.filter((h) => h.note.trim()).length + own.length;
  const markdown = () =>
    notebookMarkdown(
      { ...group, source: doc?.url ?? null, reader: `${window.location.origin}/reader/${id}` },
      highlights,
      notes,
      labels,
      new Date(),
      lang,
    );
  const openCitation = (c: ChatCitation) => router.push(`/reader/${id}?q=${encodeURIComponent(findSnippet(c.text))}`);

  async function copy() {
    try {
      await navigator.clipboard.writeText(markdown());
      showToast(t("notebook.copied"));
    } catch {
      showToast(t("notebook.copyFailed"));
    }
  }

  return (
    <div className="mx-auto flex max-w-[820px] flex-col gap-7">
      {back}

      <header className="flex flex-col gap-3.5">
        <span className="flex flex-wrap items-center gap-1.5">
          <span className={`flex h-6 w-11 items-center justify-center rounded-[5px] text-[11px] font-bold ${KIND_CLASS[group.file_type]}`}>
            {KIND_LABEL[group.file_type]}
          </span>
          <span className={`flex h-6 items-center rounded-full px-2 text-xs font-medium ${state === "read" ? "bg-success-soft text-success" : "bg-soft text-ink"}`}>
            {state === "read"
              ? t("notebook.read")
              : state === "reading"
                ? t("notebook.reading", { n: Math.round((group.read_fraction ?? 0) * 100) })
                : t("notebook.unread")}
          </span>
        </span>
        <h1 className="page-title">{group.title}</h1>
        <p className="text-[15px] text-muted">
          {[
            t("notebook.nHighlights", { n: highlights.length }),
            t("notebook.nNotes", { n: noted }),
            ...(ai.length ? [t("notebook.nInsights", { n: ai.length })] : []),
            t("notebook.updated", { when: relativeTime(group.last_activity_at, lang) }),
          ].join(" · ")}
        </p>
        <div className="flex flex-wrap gap-2.5 max-md:grid max-md:grid-cols-2">
          <Link href={`/reader/${id}`} className="btn-primary max-md:col-span-2">
            <Icon name="book" size={16} />
            {t("notebook.openDocument")}
          </Link>
          {highlights.length > 0 && (
            <Link href={`/notebooks/new?document=${id}&from=notebook`} className="btn-outline max-md:col-span-2">
              <Icon name="spark" size={16} />
              {t("notebooks.generate")}
            </Link>
          )}
          <button type="button" className="btn-outline" onClick={() => void copy()}>
            <Icon name="copy" size={16} />
            {t("notebook.copy")}
          </button>
          <button
            type="button"
            className="btn-outline"
            onClick={() => downloadText(markdown(), exportFileName(group.title).replace("puremind-highlight", "puremind-notebook"))}
          >
            <Icon name="download" size={16} />
            {t("highlights.export")}
          </button>
        </div>
      </header>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2.5 border-y border-line py-3">
        <div
          role="group"
          aria-label={t("notebook.filterAria")}
          className="flex flex-wrap gap-1.5 max-md:-mx-4 max-md:w-[calc(100%+32px)] max-md:flex-nowrap max-md:overflow-x-auto max-md:px-4 max-md:[scrollbar-width:none]"
        >
          {FILTERS.map(([value, label]) => (
            <button
              key={value}
              type="button"
              aria-pressed={filter === value}
              onClick={() => setFilter(value)}
              className="chip h-9 px-3 text-[13px] max-md:h-11 max-md:px-3.5 max-md:text-sm"
            >
              {t(label)}
            </button>
          ))}
        </div>
        <span className="flex-1 max-md:hidden" />
        <label className="relative block min-w-0 max-md:flex-1 md:w-[220px]">
          <span className="sr-only">{t("notebook.searchInAria")}</span>
          <Icon name="search" size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
          <input
            type="search"
            value={text}
            maxLength={200}
            onChange={(e) => setText(e.target.value)}
            placeholder={t("notebook.searchInPlaceholder")}
            className="input h-9 pl-9 text-sm max-md:h-11"
          />
        </label>
        <label className="flex items-center gap-2 text-[13px] text-muted max-md:min-w-0 max-md:flex-1">
          <span className="max-md:sr-only">{t("notebook.sortLabel")}</span>
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as NotebookSort)}
            className="h-9 rounded-full border border-field bg-surface pl-3 pr-7 text-[13px] text-ink outline-none focus:border-focus max-md:h-11 max-md:w-full max-md:min-w-0"
          >
            {SORTS.map(([value, label]) => (
              <option key={value} value={value}>
                {t(label)}
              </option>
            ))}
          </select>
        </label>
      </div>

      {nothingShown && <p className="py-4 text-[15px] text-muted">{t(q ? "notebook.noneMatch" : "notebook.noneOfKind")}</p>}

      {shownHighlights.length > 0 && (
        <Section title={t(filter === "notes" ? "notebook.sectionNoted" : "notebook.sectionHighlights")} count={shownHighlights.length}>
          {shownHighlights.map((h) => (
            <HighlightCard
              key={h.id}
              h={h}
              active={false}
              editing={h.id === editingId}
              onJump={() => router.push(`/reader/${id}?hl=${h.id}`)}
              onEdit={() => setEditingId(h.id)}
              onDone={() => setEditingId(null)}
            />
          ))}
        </Section>
      )}

      {(shownOwn.length > 0 || ((filter === "all" || filter === "notes") && !q)) && (
        <Section
          title={t("notebook.sectionFree")}
          count={shownOwn.length}
          action={
            <Link
              href={`/reader/${id}?panel=notes`}
              className="text-[13px] font-medium text-accent-text hover:underline max-md:-my-2 max-md:flex max-md:h-11 max-md:items-center"
            >
              {t("notebook.inDocument")}
            </Link>
          }
        >
          {shownOwn.map((n) => (
            <NoteCard key={n.id} note={n} onOpen={openCitation} />
          ))}
          {!q && <NoteComposer docId={id} />}
        </Section>
      )}

      {shownAi.length > 0 && (
        <Section title={t("notebook.sectionAi")} count={shownAi.length}>
          <p className="-mt-1 text-[13px] leading-normal text-muted">{t("notebook.aiLede")}</p>
          {shownAi.map((n) => (
            <NoteCard key={n.id} note={n} onOpen={openCitation} />
          ))}
        </Section>
      )}
    </div>
  );
}

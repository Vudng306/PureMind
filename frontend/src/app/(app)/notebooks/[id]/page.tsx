"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { HighlightPicker } from "@/components/highlight-picker";
import { Icon } from "@/components/icons";
import { NotebookMarkdown } from "@/components/notebook-markdown";
import { Alert, ConfirmDialog, Spinner, useModal } from "@/components/ui";
import { categoryLabel } from "@/lib/annotations";
import { ApiError } from "@/lib/api";
import { formatDate } from "@/lib/documents";
import { useLang, useT } from "@/lib/i18n";
import { MSG } from "@/lib/messages";
import {
  MAX_NOTEBOOK_CHARS,
  MAX_NOTEBOOK_TITLE,
  STATUS_LABEL,
  citedPositions,
  useDeleteNotebook,
  useNotebook,
  useNotebookVersion,
  useNotebookVersions,
  useUpdateNotebook,
  type Notebook,
  type NotebookPatch,
  type NotebookSource,
  type NotebookVersion,
} from "@/lib/notebooks";
import { useUi } from "@/lib/ui-store";

const AUTOSAVE_MS = 5000; // FR-NB-03

const timeOf = (iso: string, lang: string) =>
  new Date(iso).toLocaleTimeString(lang === "en" ? "en-GB" : "vi-VN", { hour: "2-digit", minute: "2-digit" });

function SourceItem({ source, onRemove, busy }: { source: NotebookSource; onRemove: () => void; busy: boolean }) {
  const t = useT();
  const lang = useLang();
  const h = source.highlight;
  return (
    <li id={`source-${source.position}`} className="flex gap-2.5 rounded-xl border border-line bg-surface p-3">
      <span className="mt-0.5 flex h-6 min-w-6 shrink-0 items-center justify-center rounded bg-accent/15 px-1 font-sans text-xs font-semibold text-accent">
        {source.position}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <span className="line-clamp-3 font-serif text-[15px] leading-snug text-ink">
          <span className={`box-decoration-clone hl-bg-${h.color}`}>{h.selected_text}</span>
        </span>
        <span className="truncate text-xs text-muted">
          {h.category ? `${categoryLabel(h.category, lang)} · ` : ""}
          {source.document_title}
          {h.page_number ? ` · ${t("search.pageOf", { page: h.page_number })}` : ""}
        </span>
        <Link href={`/reader/${h.document_id}?hl=${h.id}`} className="self-start text-xs font-semibold text-accent hover:underline">
          {t("nb.openInDocument")}
        </Link>
      </div>
      <button
        type="button"
        className="icon-btn -mr-1.5 -mt-1.5 h-8 w-8 text-muted"
        aria-label={t("nb.dropSource", { n: source.position })}
        title={t("nb.dropSourceTitle")}
        onClick={onRemove}
        disabled={busy}
      >
        <Icon name="x" size={16} />
      </button>
    </li>
  );
}

function AddSourcesDialog({
  open,
  existing,
  busy,
  onAdd,
  onClose,
}: {
  open: boolean;
  existing: Set<string>;
  busy: boolean;
  onAdd: (ids: string[]) => void;
  onClose: () => void;
}) {
  const t = useT();
  const ref = useModal(open);
  const [picked, setPicked] = useState<string[]>([]);
  useEffect(() => {
    if (open) setPicked([]);
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-label={t("nb.addSources")}
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onClose();
      }}
      className="dialog w-[min(calc(100vw-32px),760px)]"
    >
      <div className="flex max-h-[calc(100vh-32px)] flex-col">
        <div className="flex items-center gap-3 border-b border-line px-6 py-4">
          <h2 className="flex-1 font-serif text-2xl font-medium">{t("nb.addSources")}</h2>
          <button type="button" className="icon-btn" aria-label={t("common.close")} onClick={onClose} disabled={busy}>
            <Icon name="x" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4 [&_.sticky]:top-0">
          {open && <HighlightPicker selected={picked} onChange={setPicked} fixed={existing} />}
        </div>
        <div className="flex justify-end gap-2.5 border-t border-line px-6 py-4">
          <button type="button" className="btn-outline" onClick={onClose} disabled={busy}>
            {t("common.cancel")}
          </button>
          <button type="button" className="btn-primary" onClick={() => onAdd(picked)} disabled={busy || picked.length === 0}>
            {busy ? t("nb.adding") : t("nb.addN", { n: picked.length })}
          </button>
        </div>
      </div>
    </dialog>
  );
}

const dateTimeOf = (iso: string, lang: string) =>
  new Date(iso).toLocaleString(lang === "en" ? "en-GB" : "vi-VN", {
    hour: "2-digit",
    minute: "2-digit",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });

/** FR-NB-03 step 5 (F-54): the snapshots kept by "Lưu"; one can be put back into the editor. */
function VersionsDialog({
  open,
  notebookId,
  sources,
  onRestore,
  onClose,
}: {
  open: boolean;
  notebookId: string;
  sources: NotebookSource[];
  onRestore: (version: NotebookVersion) => void;
  onClose: () => void;
}) {
  const t = useT();
  const lang = useLang();
  const ref = useModal(open);
  const list = useNotebookVersions(notebookId, open);
  const [picked, setPicked] = useState<string | null>(null);
  const versions = list.data ?? [];
  const selected = picked ?? versions[0]?.id ?? null;
  const version = useNotebookVersion(notebookId, open ? selected : null);

  useEffect(() => {
    if (open) setPicked(null);
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-label={t("notebooks.versions")}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      className="dialog w-[min(calc(100vw-32px),1000px)]"
    >
      <div className="flex max-h-[calc(100vh-32px)] flex-col">
        <div className="flex items-center gap-3 border-b border-line px-6 py-4">
          <h2 className="flex-1 font-serif text-2xl font-medium">{t("notebooks.versions")}</h2>
          <button type="button" className="icon-btn" aria-label={t("common.close")} onClick={onClose}>
            <Icon name="x" />
          </button>
        </div>
        {list.isPending ? (
          <div className="px-6 py-8">
            <Spinner />
          </div>
        ) : list.isError ? (
          <div className="flex flex-col items-start gap-3 px-6 py-6">
            <Alert>{list.error instanceof Error ? list.error.message : MSG["MSG-99"]}</Alert>
            <button type="button" className="btn-outline" onClick={() => list.refetch()}>
              {t("common.retry")}
            </button>
          </div>
        ) : versions.length === 0 ? (
          <p className="px-6 py-10 text-center text-[15px] text-muted">
            {t("nb.noVersions")}
          </p>
        ) : (
          <div className="grid min-h-0 flex-1 grid-rows-[auto_minmax(0,1fr)] sm:grid-cols-[240px_minmax(0,1fr)] sm:grid-rows-1">
            <ul className="flex max-h-[30vh] flex-col gap-1 overflow-y-auto border-b border-line p-3 sm:max-h-none sm:border-b-0 sm:border-r" aria-label={t("nb.versions")}>
              {versions.map((v, i) => (
                <li key={v.id}>
                  <button
                    type="button"
                    aria-pressed={selected === v.id}
                    onClick={() => setPicked(v.id)}
                    className={`flex w-full flex-col gap-0.5 rounded-lg px-3 py-2 text-left ${
                      selected === v.id ? "bg-soft" : "hover:bg-soft/60"
                    }`}
                  >
                    <span className="text-sm font-semibold text-ink">
                      {dateTimeOf(v.created_at, lang)}
                      {i === 0 ? ` · ${t("nb.latest")}` : ""}
                    </span>
                    <span className="truncate text-xs text-muted">
                      {v.title} · {t("nb.chars", { n: v.chars.toLocaleString(lang) })}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            <div className="min-h-[40vh] overflow-y-auto px-5 py-5 sm:px-8">
              {version.isPending ? (
                <Spinner />
              ) : version.isError ? (
                <Alert>{version.error instanceof Error ? version.error.message : MSG["MSG-99"]}</Alert>
              ) : version.data.content.trim() ? (
                <NotebookMarkdown content={version.data.content} sources={sources} title={version.data.title} />
              ) : (
                <p className="text-muted">{t("nb.emptyVersion")}</p>
              )}
            </div>
          </div>
        )}
        <div className="flex flex-wrap items-center justify-end gap-2.5 border-t border-line px-6 py-4">
          <span className="mr-auto text-xs text-muted">{t("nb.restoreNote")}</span>
          <button type="button" className="btn-outline" onClick={onClose}>
            {t("common.close")}
          </button>
          <button type="button" className="btn-primary" disabled={!version.data} onClick={() => version.data && onRestore(version.data)}>
            {t("nb.restoreThis")}
          </button>
        </div>
      </div>
    </dialog>
  );
}

/** UI-08, FR-NB-03/04/05: edit the Markdown with a preview, manage sources, save or delete. */
function Editor({ notebook }: { notebook: Notebook }) {
  const t = useT();
  const lang = useLang();
  const router = useRouter();
  const showToast = useUi((s) => s.showToast);
  const update = useUpdateNotebook(notebook.id);
  const { mutateAsync } = update;
  const remove = useDeleteNotebook();

  const [title, setTitle] = useState(notebook.title);
  const [content, setContent] = useState(notebook.content);
  const [mode, setMode] = useState<"preview" | "edit">("preview");
  const [saving, setSaving] = useState<"auto" | "save" | null>(null);
  const [savedAt, setSavedAt] = useState(notebook.updated_at);
  const [autoFailed, setAutoFailed] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [history, setHistory] = useState(false);

  // What the server has, to know what is unsaved.
  const stored = useRef({ title: notebook.title, content: notebook.content });
  const latest = useRef({ title, content });
  latest.current = { title, content };
  const deleted = useRef(false);

  const dirty = title !== stored.current.title || content !== stored.current.content;
  const tooLong = content.length > MAX_NOTEBOOK_CHARS;
  const titleOk = title.trim().length > 0 && title.length <= MAX_NOTEBOOK_TITLE;
  const valid = titleOk && !tooLong;

  const send = useCallback(
    async (kind: "auto" | "save") => {
      const snapshot = latest.current;
      const patch: NotebookPatch = { title: snapshot.title, content: snapshot.content };
      if (kind === "save") patch.status = "saved";
      setSaving(kind);
      try {
        const nb = await mutateAsync(patch);
        stored.current = snapshot;
        setSavedAt(nb.updated_at);
        setAutoFailed(false);
        if (kind === "save") {
          setSaveError(null);
          showToast(t("nb.saved"));
        }
      } catch (e) {
        if (kind === "save") setSaveError(e instanceof ApiError && e.status === 422 ? e.message : MSG["MSG-99"]);
        else setAutoFailed(true);
      } finally {
        setSaving(null);
      }
    },
    [mutateAsync, showToast, t],
  );

  // Autosave: 5 seconds after the first unsaved change, then again while changes keep coming (the status stays).
  useEffect(() => {
    if (!dirty || !valid || saving) return;
    const t = setTimeout(() => void send("auto"), AUTOSAVE_MS);
    return () => clearTimeout(t);
  }, [dirty, valid, saving, send]);

  // Warn before leaving with unsaved changes.
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);

  // Leaving inside the app: send what is left, in the background.
  const updateRef = useRef(update);
  updateRef.current = update;
  useEffect(
    () => () => {
      const { title: t, content: c } = latest.current;
      const changed = t !== stored.current.title || c !== stored.current.content;
      if (changed && !deleted.current && t.trim() && c.length <= MAX_NOTEBOOK_CHARS) {
        updateRef.current.mutate({ title: t, content: c });
      }
    },
    [],
  );

  const sources = notebook.sources;
  const sourceIds = useMemo(() => new Set(sources.map((s) => s.highlight.id)), [sources]);
  const missing = useMemo(() => {
    const have = new Set(sources.map((s) => s.position));
    return citedPositions(content)
      .filter((n) => !have.has(n))
      .sort((a, b) => a - b);
  }, [content, sources]);

  async function setSources(ids: string[], done?: () => void) {
    setSaveError(null);
    try {
      await mutateAsync({ highlight_ids: ids });
      done?.();
    } catch (e) {
      setSaveError(e instanceof ApiError ? e.message : MSG["MSG-99"]);
    }
  }

  async function doDelete() {
    try {
      deleted.current = true;
      await remove.mutateAsync(notebook.id);
      showToast(t("nb.deleted"));
      router.replace("/notebooks");
    } catch {
      deleted.current = false;
      setConfirmDelete(false);
      setSaveError(MSG["MSG-99"]);
    }
  }

  const status = saving
    ? t("nb.statusSaving")
    : autoFailed
      ? t("nb.statusFailed")
      : dirty
        ? t("nb.statusDirty")
        : t("nb.statusSavedAt", { time: timeOf(savedAt, lang) });

  return (
    <div className="mx-auto flex max-w-[1180px] flex-col gap-6">
      <div className="flex flex-wrap items-center gap-2.5">
        <Link href="/notebooks" className="flex items-center gap-1 text-sm text-muted hover:text-ink">
          <Icon name="back" size={16} />
          {t("notebooks.title")}
        </Link>
        <span
          className={`flex h-6 items-center rounded-full px-2 text-xs font-semibold ${
            notebook.status === "saved" ? "bg-success-soft text-success" : "bg-soft text-ink"
          }`}
        >
          {t(STATUS_LABEL[notebook.status])}
        </span>
        <span className={`text-xs ${autoFailed ? "text-danger" : "text-muted"}`} role="status">
          {status}
        </span>
        <span className="flex-1" />
        <div className="flex h-10 gap-0.5 rounded-full bg-soft p-1" role="group" aria-label={t("nb.mode")}>
          {(
            [
              ["preview", "nb.modePreview"],
              ["edit", "nb.modeEdit"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              aria-pressed={mode === value}
              onClick={() => setMode(value)}
              className={`rounded-full px-3.5 text-sm ${mode === value ? "bg-surface font-semibold text-ink shadow-sm" : "text-muted hover:text-ink"}`}
            >
              {t(label)}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="icon-btn h-10 w-10"
          aria-label={t("notebooks.versions")}
          title={t("notebooks.versions")}
          onClick={() => setHistory(true)}
        >
          <Icon name="history" />
        </button>
        <button type="button" className="btn-primary h-10" onClick={() => void send("save")} disabled={!valid || saving !== null}>
          {t(saving === "save" ? "common.saving" : "common.save")}
        </button>
        <button
          type="button"
          className="icon-btn h-10 w-10"
          aria-label={t("nb.deleteNotebook")}
          title={t("nb.deleteNotebook")}
          onClick={() => setConfirmDelete(true)}
        >
          <Icon name="trash" />
        </button>
      </div>

      {saveError && <Alert>{saveError}</Alert>}

      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="flex min-w-0 flex-col gap-4">
          <label className="flex flex-col gap-1">
            <span className="sr-only">{t("nb.titleLabel")}</span>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={MAX_NOTEBOOK_TITLE}
              className="w-full rounded-lg border border-transparent bg-transparent px-1 py-1 font-serif text-3xl font-medium leading-tight text-ink outline-none hover:border-line focus:border-accent sm:text-4xl"
            />
            {!titleOk && <span className="text-sm text-danger">{t("nb.titleRequired")}</span>}
          </label>

          {mode === "edit" ? (
            <div className="flex flex-col gap-1.5">
              <label htmlFor="notebook-content" className="sr-only">
                {t("nb.markdownContent")}
              </label>
              <textarea
                id="notebook-content"
                value={content}
                onChange={(e) => setContent(e.target.value)}
                spellCheck={false}
                className="min-h-[65vh] w-full resize-y rounded-xl border border-field bg-surface p-4 font-mono text-[13.5px] leading-relaxed text-ink outline-none focus:border-accent"
              />
              <span className={`flex flex-wrap gap-x-3 text-xs ${tooLong ? "text-danger" : "text-muted"}`}>
                <span>
                  {t("nb.charCount", {
                    n: content.length.toLocaleString(lang),
                    max: MAX_NOTEBOOK_CHARS.toLocaleString(lang),
                  })}
                  {tooLong ? ` — ${MSG["MSG-29"]}` : ""}
                </span>
                <span>{t("nb.markdownHint")}</span>
              </span>
            </div>
          ) : (
            <article className="rounded-2xl border border-line bg-surface px-5 py-6 sm:px-9 sm:py-8">
              {content.trim() ? (
                <NotebookMarkdown content={content} sources={sources} title={title} />
              ) : (
                <p className="text-muted">{t("nb.emptyNotebook")}</p>
              )}
            </article>
          )}
          <span className="text-xs text-muted">
            {t("nb.madeOn", { date: formatDate(notebook.created_at) })}
            {notebook.ai_model ? ` · AI: ${notebook.ai_model}` : ""} · {t("nb.aiCaveat")}
          </span>
        </div>

        <aside className="flex flex-col gap-3 lg:sticky lg:top-[96px] lg:max-h-[calc(100vh-120px)] lg:self-start lg:overflow-y-auto" aria-label={t("nb.sourcesAria")}>
          <div className="flex items-center gap-2">
            <h2 className="eyebrow flex-1">{t("nb.sourcesCount", { n: sources.length })}</h2>
            <button type="button" className="btn-ghost h-9 px-3 text-sm" onClick={() => setAdding(true)} disabled={update.isPending}>
              <Icon name="plus" size={16} />
              {t("nb.addSources")}
            </button>
          </div>
          {sources.length === 0 && missing.length === 0 && (
            <p className="text-sm text-muted">{t("nb.noSources")}</p>
          )}
          <ul className="flex flex-col gap-2">
            {sources.map((s) => (
              <SourceItem
                key={s.highlight.id}
                source={s}
                busy={update.isPending}
                onRemove={() => void setSources(sources.filter((x) => x !== s).map((x) => x.highlight.id))}
              />
            ))}
            {missing.map((n) => (
              <li key={`missing-${n}`} className="flex items-center gap-2.5 rounded-xl border border-dashed border-line p-3 text-sm text-muted">
                <span className="flex h-6 min-w-6 items-center justify-center rounded bg-soft px-1 text-xs font-semibold line-through">
                  {n}
                </span>
                {t("nb.removedSource")}
              </li>
            ))}
          </ul>
        </aside>
      </div>

      <AddSourcesDialog
        open={adding}
        existing={sourceIds}
        busy={update.isPending}
        onClose={() => setAdding(false)}
        onAdd={(ids) => void setSources([...sources.map((s) => s.highlight.id), ...ids], () => setAdding(false))}
      />

      <VersionsDialog
        open={history}
        notebookId={notebook.id}
        sources={sources}
        onClose={() => setHistory(false)}
        onRestore={(v) => {
          setTitle(v.title);
          setContent(v.content);
          setMode("preview");
          setHistory(false);
          showToast(t("nb.restored"));
        }}
      />

      <ConfirmDialog
        open={confirmDelete}
        title={t("notebooks.deleteTitle")}
        busy={remove.isPending}
        onConfirm={() => void doDelete()}
        onCancel={() => setConfirmDelete(false)}
      >
        {t("nb.deleteBody", { title: notebook.title })}
      </ConfirmDialog>
    </div>
  );
}

export default function NotebookPage() {
  const t = useT();
  const { id } = useParams<{ id: string }>();
  const query = useNotebook(id);

  if (query.isPending) return <Spinner />;
  if (query.isError) {
    const notFound = query.error instanceof ApiError && query.error.status === 404;
    return (
      <div className="mx-auto flex max-w-[880px] flex-col items-start gap-3">
        <Alert>
          {notFound ? t("nb.notFound") : query.error instanceof Error ? query.error.message : MSG["MSG-99"]}
        </Alert>
        {notFound ? (
          <Link href="/notebooks" className="btn-outline">
            {t("nb.backToList")}
          </Link>
        ) : (
          <button type="button" className="btn-outline" onClick={() => query.refetch()}>
            {t("common.retry")}
          </button>
        )}
      </div>
    );
  }
  return <Editor key={query.data.id} notebook={query.data} />;
}

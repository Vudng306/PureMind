"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";

import { AddToNotebookDialog } from "@/components/add-to-notebook";
import { CitationDialog } from "@/components/citation-dialog";
import { Icon } from "@/components/icons";
import { kindLabel } from "@/components/post-cards";
import { Alert, ConfirmDialog, PageHeader, Spinner, useModal } from "@/components/ui";
import { useHighlights } from "@/lib/annotations";
import { BIBTEX_MIME, bibFileName, bibtex } from "@/lib/citation";
import { KIND_LABEL, isProcessing, origin, progressLabel, progressOf, relativeTime, type ReadState } from "@/lib/doc-view";
import { MAX_DOCUMENT_TITLE, useDeleteDocument, useDocuments, useUpdateDocument } from "@/lib/documents";
import { downloadText } from "@/lib/export";
import type { Topic } from "@/lib/feed";
import { useLang, useMsg, useT, type Key, type T } from "@/lib/i18n";
import {
  MAX_COLLECTION_NAME,
  NO_FILTERS,
  continueReading,
  filterDocuments,
  noDerivatives,
  recentDocuments,
  useCollections,
  useCreateCollection,
  useDeleteCollection,
  useDocumentUsage,
  useMoveDocument,
  useRenameCollection,
  type Collection,
  type LibraryFilters,
} from "@/lib/library";
import { MSG, messageFor } from "@/lib/messages";
import { COMMUNITY } from "@/lib/features";
import { useCreatePost, useDeletePost, useMyPosts, useUnpublishPost, type Post, type PostKind } from "@/lib/posts";
import { toneOf } from "@/lib/tone";
import type { DocumentListItem } from "@/lib/types";
import { useUi } from "@/lib/ui-store";

type Sort = "recent" | "title" | "progress";
/** The left sidebar: everything, one shelf, or what the reader has made public. */
type Place = { kind: "all" } | { kind: "collection"; id: string } | { kind: "shared" };

const SORT_LABEL: Record<Sort, Key> = {
  recent: "library.sortRecentShort",
  title: "library.sortTitleShort",
  progress: "library.sortProgress",
};
const SORT_NEXT: Record<Sort, Sort> = { recent: "title", title: "progress", progress: "recent" };
const READ_LABEL: Record<ReadState | "all", Key> = {
  all: "library.readAll",
  unread: "library.readUnread",
  reading: "library.readReading",
  read: "library.readDone",
};
const FILE_TYPES = ["pdf", "epub", "web"] as const;
const FILTER_SELECT =
  "h-10 rounded-full border border-line bg-surface pl-3.5 pr-8 text-sm font-medium text-ink shadow-card outline-none focus:border-focus";

interface CardActions {
  onAddToNotebook: () => void;
  onCreatePost: () => void;
  onShareOriginal: () => void;
  onRename: () => void;
  onMove: () => void;
  onCite: () => void;
  onToggleRead: () => void;
  onDelete: () => void;
}

/** F-16: the card's "⋯" menu. Closes on Escape, on a click outside and after a choice. */
function CardMenu({ doc, actions }: { doc: DocumentListItem; actions: CardActions }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    root.current?.querySelector<HTMLElement>("[role=menuitem]")?.focus();
    const onDown = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open]);

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape" && open) {
      setOpen(false);
      button.current?.focus();
    } else if (open && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      e.preventDefault();
      const items = [...(root.current?.querySelectorAll<HTMLElement>("[role=menuitem]") ?? [])];
      const i = items.indexOf(document.activeElement as HTMLElement);
      items[(i + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length]?.focus();
    }
  }

  const choose = (action: () => void) => () => {
    setOpen(false);
    action();
  };
  const item = "flex h-10 w-full items-center gap-2.5 rounded-lg px-3 text-left text-sm hover:bg-soft focus:bg-soft focus:outline-none";

  return (
    <div ref={root} className="absolute right-1.5 top-1.5 z-10" onKeyDown={onKeyDown}>
      <button
        ref={button}
        type="button"
        onClick={() => setOpen(!open)}
        aria-label={t("library.cardMenu", { title: doc.title })}
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex h-11 w-11 items-center justify-center rounded-[10px] opacity-70 transition hover:bg-surface/60 hover:opacity-100 aria-expanded:bg-surface/60 aria-expanded:opacity-100"
      >
        <Icon name="more" />
      </button>
      {open && (
        <div
          role="menu"
          aria-label={doc.title}
          className="absolute right-0 top-12 flex w-60 flex-col gap-0.5 rounded-xl border border-line bg-surface p-1.5 text-ink shadow-float"
        >
          <Link href={`/reader/${doc.id}`} role="menuitem" className={item}>
            <Icon name="book" size={16} />
            {t("library.readAction")}
          </Link>
          <button type="button" role="menuitem" className={item} onClick={choose(actions.onAddToNotebook)}>
            <Icon name="note" size={16} />
            {t("library.addToNotebook")}
          </button>
          {COMMUNITY && (
            <>
              <button type="button" role="menuitem" className={item} onClick={choose(actions.onCreatePost)}>
                <Icon name="pencil" size={16} />
                {t("library.createPost")}
              </button>
              <button type="button" role="menuitem" className={item} onClick={choose(actions.onShareOriginal)}>
                <Icon name="link" size={16} />
                {t("library.shareOriginal")}
              </button>
            </>
          )}
          <span role="separator" className="my-1 border-t border-line" />
          <span className="px-3 pb-0.5 text-xs font-semibold text-muted">{t("library.manage")}</span>
          <button type="button" role="menuitem" className={item} onClick={choose(actions.onRename)}>
            <Icon name="pencil" size={16} />
            {t("common.rename")}
          </button>
          <button type="button" role="menuitem" className={item} onClick={choose(actions.onMove)}>
            <Icon name="file" size={16} />
            {t("library.moveToCollection")}
          </button>
          <button type="button" role="menuitem" className={item} onClick={choose(actions.onCite)}>
            <Icon name="quote" size={16} />
            {t("library.cite")}
          </button>
          <button type="button" role="menuitem" className={item} onClick={choose(actions.onToggleRead)}>
            <Icon name={doc.is_read ? "minus" : "check"} size={16} />
            {t(doc.is_read ? "library.markUnread" : "library.markRead")}
          </button>
          <button type="button" role="menuitem" className={`${item} text-danger`} onClick={choose(actions.onDelete)}>
            <Icon name="trash" size={16} />
            {t("library.removeFromLibrary")}
          </button>
        </div>
      )}
    </div>
  );
}

/** One line of text in a dialog: a document's new title, a shelf's name. */
function NameDialog({
  open,
  title,
  label,
  initial,
  maxLength,
  busy,
  error,
  onSave,
  onClose,
}: {
  open: boolean;
  title: string;
  label: string;
  initial: string;
  maxLength: number;
  busy: boolean;
  error: string | null;
  onSave: (name: string) => void;
  onClose: () => void;
}) {
  const t = useT();
  const ref = useModal(open);
  const [name, setName] = useState("");
  useEffect(() => {
    if (open) setName(initial);
  }, [open, initial]);
  const clean = name.split(/\s+/).filter(Boolean).join(" ");
  const ok = clean.length > 0 && clean !== initial;

  return (
    <dialog
      ref={ref}
      aria-label={title}
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onClose();
      }}
      className="dialog w-[min(calc(100vw-32px),480px)]"
    >
      <form
        className="flex flex-col gap-3.5 p-[26px]"
        onSubmit={(e) => {
          e.preventDefault();
          if (ok && !busy) onSave(clean);
        }}
      >
        <h2 className="font-serif text-2xl font-medium">{title}</h2>
        <label className="flex flex-col gap-1.5">
          <span className="text-sm text-muted">{label}</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={maxLength}
            className="h-11 rounded-lg border border-field bg-surface px-3 text-[15px] text-ink outline-none focus:border-focus"
          />
        </label>
        {error && <Alert>{error}</Alert>}
        <div className="mt-1.5 flex justify-end gap-2.5">
          <button type="button" className="btn-outline" onClick={onClose} disabled={busy}>
            {t("common.cancel")}
          </button>
          <button type="submit" className="btn-primary" disabled={!ok || busy}>
            {t(busy ? "common.saving" : "common.save")}
          </button>
        </div>
      </form>
    </dialog>
  );
}

/** A document sits on one shelf at most. Moving it touches nothing else. */
function MoveDialog({
  doc,
  collections,
  onClose,
}: {
  doc: DocumentListItem | null;
  collections: Collection[];
  onClose: () => void;
}) {
  const t = useT();
  const showToast = useUi((s) => s.showToast);
  const ref = useModal(doc !== null);
  const move = useMoveDocument();
  const create = useCreateCollection();
  const [picked, setPicked] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const busy = move.isPending || create.isPending;

  useEffect(() => {
    if (doc) {
      setPicked(doc.collection_id ?? "");
      setName("");
      setError(null);
    }
  }, [doc]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!doc) return;
    setError(null);
    try {
      const clean = name.trim();
      const target = clean ? (await create.mutateAsync(clean)).id : picked || null;
      await move.mutateAsync({ id: doc.id, collectionId: target });
      showToast(t("library.moved"));
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : MSG["MSG-99"]);
    }
  }

  const field = "h-11 rounded-lg border border-field bg-surface px-3 text-[15px] text-ink outline-none focus:border-focus";

  return (
    <dialog
      ref={ref}
      aria-label={t("library.moveToCollection")}
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onClose();
      }}
      className="dialog w-[min(calc(100vw-32px),480px)]"
    >
      <form className="flex flex-col gap-3.5 p-[26px]" onSubmit={(e) => void save(e)}>
        <h2 className="font-serif text-2xl font-medium">{t("library.moveToCollection")}</h2>
        <p className="truncate text-sm text-muted">{doc?.title}</p>
        <label className="flex flex-col gap-1.5">
          <span className="text-sm text-muted">{t("library.collectionLabel")}</span>
          <select value={picked} disabled={Boolean(name.trim())} onChange={(e) => setPicked(e.target.value)} className={field}>
            <option value="">{t("library.noCollection")}</option>
            {collections.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-sm text-muted">{t("library.orNewCollection")}</span>
          <input value={name} maxLength={MAX_COLLECTION_NAME} onChange={(e) => setName(e.target.value)} className={field} />
        </label>
        {error && <Alert>{error}</Alert>}
        <div className="mt-1.5 flex justify-end gap-2.5">
          <button type="button" className="btn-outline" onClick={onClose} disabled={busy}>
            {t("common.cancel")}
          </button>
          <button type="submit" className="btn-primary" disabled={busy}>
            {t(busy ? "common.saving" : "common.save")}
          </button>
        </div>
      </form>
    </dialog>
  );
}

/** Says, with this document's own numbers, what goes and what stays. The button waits for the numbers. */
function RemoveDialog({
  doc,
  busy,
  onConfirm,
  onCancel,
}: {
  doc: DocumentListItem | null;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const t = useT();
  const usage = useDocumentUsage(doc?.id ?? null);
  const data = usage.data;
  const lost: string[] = [];
  if (data) {
    lost.push(t("library.removeHighlights", { n: data.highlights, notes: data.notes }));
    if (data.has_summary) lost.push(t("library.removeSummary"));
    lost.push(t("library.removeChat"));
  }
  return (
    <ConfirmDialog
      open={doc !== null}
      title={t("library.removeTitle")}
      busy={busy}
      confirmDisabled={!data}
      confirmLabel={t("library.removeConfirm")}
      onCancel={onCancel}
      onConfirm={onConfirm}
    >
      <span className="flex flex-col gap-2.5">
        <span>{t("library.removeLead", { title: doc?.title ?? "" })}</span>
        {usage.isPending && <span className="text-muted">{t("common.loading")}</span>}
        {usage.isError && <span className="text-danger">{t("library.removeNoUsage")}</span>}
        {data && (
          <>
            <span className="font-semibold text-ink">{t("library.removeLost")}</span>
            <span className="flex flex-col gap-1">
              {lost.map((line) => (
                <span key={line}>• {line}</span>
              ))}
            </span>
            {(data.notebooks > 0 || data.posts > 0) && (
              <>
                <span className="font-semibold text-ink">{t("library.removeKept")}</span>
                <span className="flex flex-col gap-1">
                  {data.notebooks > 0 && <span>• {t("library.removeNotebooks", { n: data.notebooks })}</span>}
                  {data.posts > 0 && <span>• {t("library.removePosts", { n: data.posts })}</span>}
                </span>
              </>
            )}
          </>
        )}
      </span>
    </ConfirmDialog>
  );
}

function DocumentCard({ doc, actions }: { doc: DocumentListItem; actions: CardActions }) {
  const t = useT();
  const pct = progressOf(doc);
  const failed = doc.extraction_status === "failed";
  const processing = isProcessing(doc);
  const initial = doc.title.trim().charAt(0).toUpperCase() || "?";

  return (
    <article className={`card group relative flex flex-col transition-[box-shadow,transform] hover:-translate-y-0.5 hover:shadow-float ${toneOf(doc.title)}`}>
      <div className="cover-art relative flex h-[132px] items-end rounded-t-[17px] px-5 pb-3">
        <span aria-hidden className="font-display text-[76px] font-semibold leading-none">
          {initial}
        </span>
        <span className="absolute left-3 top-3 flex h-6 items-center rounded-full bg-surface px-2.5 text-xs font-bold text-ink">
          {KIND_LABEL[doc.file_type]}
        </span>
        <CardMenu doc={doc} actions={actions} />
      </div>
      <div className="flex flex-1 flex-col gap-1.5 p-4">
        <Link
          href={`/reader/${doc.id}`}
          className="line-clamp-2 font-display text-[19px] font-semibold leading-[1.3] after:absolute after:inset-0 hover:underline"
        >
          {doc.title}
        </Link>
        <span className="truncate text-[13px] text-muted">
          {origin(doc)} · {relativeTime(doc.updated_at)}
        </span>
        <span className="min-h-2.5 flex-1" />
        {processing ? (
          <div role="status" className="flex flex-col gap-2.5 pb-3">
            <span className="relative h-1 overflow-hidden rounded-sm bg-soft">
              <span className="absolute left-0 top-0 h-1 w-2/5 animate-pm-slide rounded-sm bg-accent" />
            </span>
            <span className="text-[13px] text-muted">{t("library.extracting")}</span>
          </div>
        ) : failed && doc.file_type !== "pdf" ? (
          <span className="text-[13px] leading-snug text-danger">{messageFor(doc.extraction_error)}</span>
        ) : (
          <div className="flex flex-col gap-2.5">
            {failed ? (
              <span className="text-[13px] leading-snug text-danger">{messageFor(doc.extraction_error)}</span>
            ) : (
              <span className="h-1 rounded-sm bg-soft">
                <span
                  className={`block h-1 rounded-sm ${pct >= 100 ? "bg-success" : "bg-accent"}`}
                  style={{ width: `${Math.min(100, pct)}%` }}
                />
              </span>
            )}
            <div className="flex items-center justify-between gap-2">
              <span className="truncate text-[13px] text-muted">{failed ? "" : progressLabel(doc, pct)}</span>
              <span className="btn-outline pointer-events-none h-10 px-4 text-sm font-semibold group-hover:border-accent group-hover:text-accent-text">{t(failed ? "library.viewOriginal" : "library.readAction")}</span>
            </div>
          </div>
        )}
      </div>
    </article>
  );
}

/** Where the reader left off: the latest large, a couple more beside it. Each reopens at its own position. */
function ContinueReading({ docs }: { docs: DocumentListItem[] }) {
  const t = useT();
  const [first, ...rest] = docs;
  const pct = progressOf(first);
  return (
    <section aria-label={t("library.continue")} className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_300px]">
      <div className="relative overflow-hidden rounded-[22px] bg-ink text-bg shadow-float">
        <span aria-hidden className="absolute -right-16 -top-24 h-72 w-72 rounded-full bg-accent/90" />
        <span aria-hidden className="absolute -bottom-28 right-40 h-56 w-56 rounded-full bg-accent/30" />
        <div className="relative flex flex-col gap-3 px-6 py-7 sm:max-w-[72%] sm:px-8 sm:py-8">
          <span className="text-xs font-bold tracking-[0.1em] text-white/80">{t("library.continue")}</span>
          <span className="line-clamp-3 font-display text-3xl font-semibold leading-[1.1] tracking-[-0.01em] sm:text-[36px]">{first.title}</span>
          <span className="text-[15px] text-bg/70">
            {KIND_LABEL[first.file_type]} · {origin(first)} · {progressLabel(first, pct)}
          </span>
          <span className="h-1.5 w-full max-w-[360px] rounded-full bg-bg/20">
            <span className="block h-1.5 rounded-full bg-accent" style={{ width: `${pct}%` }} />
          </span>
          <Link href={`/reader/${first.id}`} className="btn-primary mt-1 h-12 self-start px-[22px]">
            {t(pct > 0 ? "library.continueRead" : "library.startReading")}
            <Icon name="arrow" />
          </Link>
        </div>
      </div>
      {rest.length > 0 && (
        <ul className="flex flex-col gap-3">
          {rest.map((d) => {
            const p = progressOf(d);
            return (
              <li key={d.id} className="flex-1">
                <Link href={`/reader/${d.id}`} className={`card flex h-full flex-col justify-center gap-2 p-4 hover:shadow-float ${toneOf(d.title)}`}>
                  <span className="line-clamp-2 font-display text-[17px] font-semibold leading-snug text-ink">{d.title}</span>
                  <span className="h-1 rounded-sm bg-soft">
                    <span className="block h-1 rounded-sm bg-accent" style={{ width: `${p}%` }} />
                  </span>
                  <span className="truncate text-[13px] text-muted">{progressLabel(d, p)}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/** What just came in, in one short row. */
function RecentDocuments({ docs }: { docs: DocumentListItem[] }) {
  const t = useT();
  return (
    <section className="flex flex-col gap-2.5">
      <h2 className="eyebrow">{t("library.recent")}</h2>
      <ul className="grid gap-2.5 sm:grid-cols-2 xl:grid-cols-4">
        {docs.map((d) => (
          <li key={d.id}>
            <Link href={`/reader/${d.id}`} className="flex h-full items-center gap-2.5 rounded-xl border border-line bg-surface p-3 hover:border-accent">
              <span className="flex h-6 w-11 shrink-0 items-center justify-center rounded-[5px] bg-soft text-[11px] font-bold text-ink">
                {KIND_LABEL[d.file_type]}
              </span>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-sm font-semibold text-ink">{d.title}</span>
                <span className="truncate text-xs text-muted">{relativeTime(d.created_at)}</span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

const postBadge = (post: Post) =>
  post.hidden
    ? { label: "post.statusHidden" as Key, cls: "bg-danger/10 text-danger" }
    : post.status === "published"
      ? { label: "post.statusPublished" as Key, cls: "bg-success-soft text-success" }
      : { label: "post.statusDraft" as Key, cls: "bg-soft text-ink" };

function SharedPost({ post, onDelete }: { post: Post; onDelete: () => void }) {
  const t = useT();
  const showToast = useUi((s) => s.showToast);
  const unpublish = useUnpublishPost(post.id);
  const badge = postBadge(post);
  const sources = post.sources.map((s) => s.title).join(" · ");
  return (
    <li className="card flex flex-col gap-2 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className={`flex h-6 items-center rounded-full px-2 text-xs font-semibold ${badge.cls}`}>{t(badge.label)}</span>
        <span className="text-xs font-semibold text-muted">{t(kindLabel(post.kind as PostKind))}</span>
        <span className="text-xs text-muted">· {relativeTime(post.published_at ?? post.updated_at)}</span>
      </div>
      <span className="font-display text-lg font-semibold leading-snug text-ink">{post.title || t("studio.noTitle")}</span>
      {sources && <span className="line-clamp-1 text-[13px] text-muted">{t("shared.madeFrom", { sources })}</span>}
      <div className="flex flex-wrap items-center gap-1">
        <Link href={`/publish/${post.id}`} className="btn-outline h-10 px-3.5 text-sm">
          {t(post.status === "draft" ? "shared.keepWriting" : "shared.manage")}
        </Link>
        {post.status === "published" && !post.hidden && (
          <>
            <Link href={`/community/${post.id}`} className="btn-ghost h-10 px-3 text-sm">
              {t("studio.viewPublic")}
            </Link>
            <button
              type="button"
              className="btn-ghost h-10 px-3 text-sm"
              disabled={unpublish.isPending}
              onClick={() =>
                unpublish.mutate(undefined, {
                  onSuccess: () => showToast(t("studio.unpublished")),
                  onError: (e) => showToast(e instanceof Error ? e.message : MSG["MSG-99"]),
                })
              }
            >
              {t("studio.unpublish")}
            </button>
          </>
        )}
        <span className="flex-1" />
        <button type="button" className="icon-btn h-10 w-10" aria-label={t("studio.delete")} title={t("studio.delete")} onClick={onDelete}>
          <Icon name="trash" size={16} />
        </button>
      </div>
    </li>
  );
}

/** What this reader has made public, or is about to. Their documents themselves never appear here. */
function SharedByMe() {
  const t = useT();
  const showToast = useUi((s) => s.showToast);
  const posts = useMyPosts();
  const remove = useDeletePost();
  const [toDelete, setToDelete] = useState<Post | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function confirmDelete() {
    if (!toDelete) return;
    try {
      await remove.mutateAsync(toDelete.id);
      showToast(t("studio.deleted"));
    } catch (e) {
      setError(e instanceof Error ? e.message : MSG["MSG-99"]);
    } finally {
      setToDelete(null);
    }
  }

  return (
    <section className="flex flex-col gap-3.5">
      <div className="flex flex-col gap-1">
        <h2 className="font-display text-2xl font-semibold">{t("library.sharedByMe")}</h2>
        <p className="max-w-2xl text-sm text-muted">{t("shared.lede")}</p>
      </div>
      {error && <Alert>{error}</Alert>}
      {posts.isPending ? (
        <Spinner />
      ) : posts.isError ? (
        <Alert>{posts.error instanceof Error ? posts.error.message : MSG["MSG-99"]}</Alert>
      ) : posts.data.length === 0 ? (
        <p className="rounded-[14px] border border-dashed border-field px-6 py-12 text-center text-muted">{t("shared.empty")}</p>
      ) : (
        <ul className="grid gap-3 md:grid-cols-2">
          {posts.data.map((post) => (
            <SharedPost key={post.id} post={post} onDelete={() => setToDelete(post)} />
          ))}
        </ul>
      )}
      <ConfirmDialog
        open={toDelete !== null}
        title={t("studio.deleteTitle")}
        busy={remove.isPending}
        onConfirm={() => void confirmDelete()}
        onCancel={() => setToDelete(null)}
      >
        {t("studio.deleteBody")}
      </ConfirmDialog>
    </section>
  );
}

function Sidebar({
  place,
  onPlace,
  total,
  highlights,
  shared,
  collections,
  onNew,
  onRename,
  onDelete,
}: {
  place: Place;
  onPlace: (place: Place) => void;
  total: number;
  highlights: number;
  shared: number;
  collections: Collection[];
  onNew: () => void;
  onRename: (c: Collection) => void;
  onDelete: (c: Collection) => void;
}) {
  const t = useT();
  const row = (active: boolean) =>
    `flex min-h-10 min-w-0 flex-1 items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-sm ${
      active ? "bg-soft font-semibold text-ink" : "text-body hover:bg-soft/70"
    }`;
  const count = "text-xs text-muted";
  return (
    <nav aria-label={t("library.sections")} className="flex flex-col gap-1 lg:sticky lg:top-[96px] lg:self-start">
      <button type="button" className={row(place.kind === "all")} aria-pressed={place.kind === "all"} onClick={() => onPlace({ kind: "all" })}>
        <Icon name="book" size={16} className="shrink-0" />
        <span className="flex-1 truncate">{t("library.allDocuments")}</span>
        <span className={count}>{total}</span>
      </button>
      <Link href="/highlights" className={row(false)}>
        <Icon name="highlighter" size={16} className="shrink-0" />
        <span className="flex-1 truncate">{t("library.highlights")}</span>
        <span className={count}>{highlights}</span>
      </Link>
      {COMMUNITY && (
        <button type="button" className={row(place.kind === "shared")} aria-pressed={place.kind === "shared"} onClick={() => onPlace({ kind: "shared" })}>
          <Icon name="link" size={16} className="shrink-0" />
          <span className="flex-1 truncate">{t("library.sharedByMe")}</span>
          <span className={count}>{shared}</span>
        </button>
      )}
      <div className="mt-3 flex items-center gap-1 px-2.5">
        <span className="eyebrow flex-1">{t("library.collections")}</span>
        <button type="button" className="icon-btn h-8 w-8" aria-label={t("library.newCollection")} title={t("library.newCollection")} onClick={onNew}>
          <Icon name="plus" size={16} />
        </button>
      </div>
      {collections.length === 0 && <p className="px-2.5 text-xs leading-snug text-muted">{t("library.collectionsHint")}</p>}
      <ul className="flex flex-col gap-0.5">
        {collections.map((c) => {
          const active = place.kind === "collection" && place.id === c.id;
          return (
            <li key={c.id} className="group/row flex items-center">
              <button type="button" className={row(active)} aria-pressed={active} onClick={() => onPlace({ kind: "collection", id: c.id })}>
                <span className="flex-1 truncate">{c.name}</span>
                <span className={count}>{c.document_count}</span>
              </button>
              <button type="button" className="icon-btn h-8 w-8 shrink-0" aria-label={t("library.renameCollection", { name: c.name })} onClick={() => onRename(c)}>
                <Icon name="pencil" size={14} />
              </button>
              <button type="button" className="icon-btn h-8 w-8 shrink-0" aria-label={t("library.deleteCollection", { name: c.name })} onClick={() => onDelete(c)}>
                <Icon name="x" size={14} />
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

export default function LibraryPage() {
  const router = useRouter();
  const [sort, setSort] = useState<Sort>("recent");
  const [place, setPlace] = useState<Place>({ kind: "all" });
  const [filters, setFilters] = useState<LibraryFilters>(NO_FILTERS);
  const { data, isLoading, isError, error, refetch } = useDocuments("created_desc");
  const collections = useCollections();
  const posts = useMyPosts();
  const del = useDeleteDocument();
  const update = useUpdateDocument();
  const createPost = useCreatePost();
  const createCollection = useCreateCollection();
  const renameCollection = useRenameCollection();
  const deleteCollection = useDeleteCollection();
  const [toRename, setToRename] = useState<DocumentListItem | null>(null);
  const [renameError, setRenameError] = useState<string | null>(null);
  const [toCite, setToCite] = useState<DocumentListItem | null>(null);
  const [toMove, setToMove] = useState<DocumentListItem | null>(null);
  const [toLink, setToLink] = useState<DocumentListItem | null>(null);
  const [toShare, setToShare] = useState<DocumentListItem | null>(null);
  const [toDelete, setToDelete] = useState<DocumentListItem | null>(null);
  const [shelfName, setShelfName] = useState<{ collection: Collection | null } | null>(null);
  const [shelfError, setShelfError] = useState<string | null>(null);
  const [shelfToDelete, setShelfToDelete] = useState<Collection | null>(null);
  const { setAddOpen, showToast } = useUi();
  const { data: highlights } = useHighlights();
  const [actionError, setActionError] = useState<string | null>(null);
  const t: T = useT();
  const msg = useMsg();
  const lang = useLang();

  // Read here rather than with useSearchParams, which would make the whole page wait for the client.
  useEffect(() => {
    if (COMMUNITY && new URLSearchParams(window.location.search).get("view") === "shared") setPlace({ kind: "shared" });
  }, []);

  const docs = useMemo(() => data ?? [], [data]);
  const shelves = useMemo(() => collections.data ?? [], [collections.data]);
  const counts = {
    all: docs.length,
    upload: docs.filter((d) => d.source_type === "upload").length,
    manual: docs.filter((d) => d.source_type === "manual").length,
  };
  const readingCount = docs.filter((d) => {
    const p = progressOf(d);
    return p > 0 && p < 100;
  }).length;
  const docIds = new Set(docs.map((d) => d.id));
  const hlCount = highlights.filter((h) => docIds.has(h.docId)).length;
  const topics = useMemo(() => [...new Set(docs.flatMap((d) => d.topics))].sort(), [docs]);
  const fileTypes = FILE_TYPES.filter((x) => docs.some((d) => d.file_type === x));

  // A shelf that was just deleted is no longer somewhere to be.
  const shelf = place.kind === "collection" ? shelves.find((c) => c.id === place.id) ?? null : null;
  const collectionId = shelf?.id ?? null;
  const view = filterDocuments(docs, { ...filters, collection: collectionId }).sort((a, b) => {
    if (sort === "title") return a.title.localeCompare(b.title, lang);
    if (sort === "progress") return progressOf(b) - progressOf(a);
    return b.updated_at.localeCompare(a.updated_at);
  });
  const filtered =
    filters.source !== "all" || filters.readState !== "all" || filters.fileType !== "all" || Boolean(filters.topic) || Boolean(filters.query.trim());
  const atHome = place.kind === "all" && !filtered;
  const continuing = atHome ? continueReading(docs) : [];
  const recent = atHome && docs.length > 4 ? recentDocuments(docs) : [];

  const patchFilters = (patch: Partial<LibraryFilters>) => setFilters((f) => ({ ...f, ...patch }));
  const goTo = (next: Place) => {
    setPlace(next);
    window.history.replaceState(null, "", next.kind === "shared" ? "/library?view=shared" : "/library");
  };

  async function confirmDelete() {
    if (!toDelete) return;
    const doc = toDelete;
    try {
      await del.mutateAsync(doc.id);
      showToast(t("library.deleted", { title: doc.title }));
    } catch (err) {
      setActionError(err instanceof Error ? err.message : MSG["MSG-99"]);
    } finally {
      setToDelete(null);
    }
  }

  async function rename(title: string) {
    if (!toRename) return;
    setRenameError(null);
    try {
      await update.mutateAsync({ id: toRename.id, patch: { title } });
      setToRename(null);
      showToast(t("library.renamed"));
    } catch (err) {
      setRenameError(err instanceof Error ? err.message : MSG["MSG-99"]);
    }
  }

  async function toggleRead(doc: DocumentListItem) {
    setActionError(null);
    try {
      await update.mutateAsync({ id: doc.id, patch: { is_read: !doc.is_read } });
      showToast(t(doc.is_read ? "library.markedUnread" : "library.markedRead"));
    } catch (err) {
      setActionError(err instanceof Error ? err.message : MSG["MSG-99"]);
    }
  }

  /** A private draft, opened in the Studio. Nothing is public until the author publishes it there. */
  async function startPost(doc: DocumentListItem, kind: PostKind) {
    setActionError(null);
    try {
      const post = await createPost.mutateAsync({ document_id: doc.id, kind });
      router.push(`/publish/${post.id}`);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : MSG["MSG-99"]);
    }
  }

  async function saveShelf(name: string) {
    if (!shelfName) return;
    setShelfError(null);
    try {
      if (shelfName.collection) await renameCollection.mutateAsync({ id: shelfName.collection.id, name });
      else await createCollection.mutateAsync(name);
      setShelfName(null);
    } catch (err) {
      setShelfError(err instanceof Error ? err.message : MSG["MSG-99"]);
    }
  }

  async function confirmDeleteShelf() {
    if (!shelfToDelete) return;
    try {
      await deleteCollection.mutateAsync(shelfToDelete.id);
      showToast(t("library.collectionDeleted"));
      if (place.kind === "collection" && place.id === shelfToDelete.id) setPlace({ kind: "all" });
    } catch (err) {
      setActionError(err instanceof Error ? err.message : MSG["MSG-99"]);
    } finally {
      setShelfToDelete(null);
    }
  }

  /** The documents on screen as a .bib file, for a reference manager or LaTeX. */
  function exportBibtex() {
    downloadText(bibtex(view), bibFileName(), BIBTEX_MIME);
    const bare = view.filter((d) => !d.citation).length;
    showToast(bare ? t("library.bibExportedBare", { n: view.length, bare }) : t("library.bibExported", { n: view.length }));
  }

  const actionsOf = (doc: DocumentListItem): CardActions => ({
    onAddToNotebook: () => setToLink(doc),
    // A post's own words about a no-derivatives article are fine; a summary of it is not.
    onCreatePost: () => void startPost(doc, noDerivatives(doc.license) ? "insight" : "summary"),
    onShareOriginal: () => setToShare(doc),
    onRename: () => {
      setRenameError(null);
      setToRename(doc);
    },
    onMove: () => setToMove(doc),
    onCite: () => setToCite(doc),
    onToggleRead: () => void toggleRead(doc),
    onDelete: () => setToDelete(doc),
  });

  return (
    <div className="mx-auto flex max-w-[1280px] flex-col gap-6">
      <PageHeader
        title={t("library.title")}
        lead={docs.length > 0 ? t("library.stats", { docs: docs.length, reading: readingCount, hl: hlCount }) : undefined}
        actions={
          <button type="button" className="btn-primary" onClick={() => setAddOpen(true)}>
            <Icon name="plus" />
            {t("nav.addDocument")}
          </button>
        }
      />

      {actionError && <Alert>{actionError}</Alert>}

      <div className="grid gap-6 lg:grid-cols-[220px_minmax(0,1fr)] lg:gap-8">
        <Sidebar
          place={place}
          onPlace={goTo}
          total={docs.length}
          highlights={hlCount}
          shared={posts.data?.length ?? 0}
          collections={shelves}
          onNew={() => {
            setShelfError(null);
            setShelfName({ collection: null });
          }}
          onRename={(c) => {
            setShelfError(null);
            setShelfName({ collection: c });
          }}
          onDelete={setShelfToDelete}
        />

        <div className="flex min-w-0 flex-col gap-7">
          {place.kind === "shared" ? (
            <SharedByMe />
          ) : (
            <>
              {shelf && <h2 className="font-display text-2xl font-semibold">{shelf.name}</h2>}
              {continuing.length > 0 && <ContinueReading docs={continuing} />}
              {recent.length > 0 && <RecentDocuments docs={recent} />}

              <div className="flex flex-wrap items-center gap-2.5">
                {(
                  [
                    ["all", "common.all"],
                    ["upload", "library.sourceUpload"],
                    ["manual", "library.sourceLink"],
                  ] as const
                ).map(([value, label]) => (
                  <button key={value} type="button" className="chip" aria-pressed={filters.source === value} onClick={() => patchFilters({ source: value })}>
                    {t(label)} · {counts[value]}
                  </button>
                ))}
                <label className="flex h-10 w-full items-center gap-2 rounded-full border border-line bg-surface px-3.5 text-muted shadow-card focus-within:border-focus sm:w-[240px]">
                  <Icon name="search" size={16} />
                  <span className="sr-only">{t("library.filterName")}</span>
                  <input
                    value={filters.query}
                    onChange={(e) => patchFilters({ query: e.target.value })}
                    placeholder={t("library.filterPlaceholder")}
                    className="min-w-0 flex-1 bg-transparent text-sm text-ink outline-none"
                  />
                </label>
                {topics.length > 0 && (
                  <label>
                    <span className="sr-only">{t("library.filterTopic")}</span>
                    <select value={filters.topic} onChange={(e) => patchFilters({ topic: e.target.value })} className={FILTER_SELECT}>
                      <option value="">{t("library.allTopics")}</option>
                      {topics.map((x) => (
                        <option key={x} value={x}>
                          {t(`feed.topic.${x as Topic}` as Key)}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                <label>
                  <span className="sr-only">{t("library.readStatus")}</span>
                  <select
                    value={filters.readState}
                    onChange={(e) => patchFilters({ readState: e.target.value as ReadState | "all" })}
                    className={FILTER_SELECT}
                  >
                    {(Object.keys(READ_LABEL) as (ReadState | "all")[]).map((value) => (
                      <option key={value} value={value}>
                        {t(READ_LABEL[value])}
                      </option>
                    ))}
                  </select>
                </label>
                {fileTypes.length > 1 && (
                  <label>
                    <span className="sr-only">{t("library.filterType")}</span>
                    <select
                      value={filters.fileType}
                      onChange={(e) => patchFilters({ fileType: e.target.value as LibraryFilters["fileType"] })}
                      className={FILTER_SELECT}
                    >
                      <option value="all">{t("library.allTypes")}</option>
                      {fileTypes.map((x) => (
                        <option key={x} value={x}>
                          {KIND_LABEL[x]}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                <button
                  type="button"
                  className="chip"
                  onClick={() => setSort(SORT_NEXT[sort])}
                  aria-label={t("library.sortLabel", { sort: t(SORT_LABEL[sort]) })}
                >
                  <Icon name="sort" size={16} />
                  {t(SORT_LABEL[sort])}
                </button>
                {view.length > 0 && (
                  <button type="button" className="chip" onClick={exportBibtex} title={t("library.exportBibHint", { n: view.length })}>
                    <Icon name="download" size={16} />
                    {t("library.exportBib")}
                  </button>
                )}
              </div>

              {isLoading ? (
                <Spinner />
              ) : isError ? (
                <div className="flex flex-col items-start gap-3">
                  <Alert>{error instanceof Error ? error.message : MSG["MSG-99"]}</Alert>
                  <button type="button" className="btn-outline" onClick={() => refetch()}>
                    {t("common.retry")}
                  </button>
                </div>
              ) : view.length === 0 ? (
                <div className="flex flex-col items-center gap-3.5 rounded-[22px] border-2 border-dashed border-field bg-surface/60 px-6 py-16 text-center">
                  <span aria-hidden className="grid h-14 w-14 place-items-center rounded-2xl bg-accent-soft text-accent-text">
                    <Icon name="book" size={26} />
                  </span>
                  <span className="font-display text-[28px] font-semibold">
                    {filtered ? t("library.noMatch") : shelf ? t("library.shelfEmpty") : msg("MSG-30")}
                  </span>
                  <span className="max-w-md text-[15px] text-muted">
                    {t(filtered ? "library.noMatchHint" : shelf ? "library.shelfEmptyHint" : "library.emptyHintLong")}
                  </span>
                  <div className="flex gap-2.5">
                    {filtered && (
                      <button type="button" className="btn-outline" onClick={() => setFilters(NO_FILTERS)}>
                        {t("library.clearFilters")}
                      </button>
                    )}
                    {!shelf && (
                      <button type="button" className="btn-primary" onClick={() => setAddOpen(true)}>
                        {t("nav.addDocument")}
                      </button>
                    )}
                    {!filtered && !shelf && (
                      <Link href="/explore" className="btn-outline">
                        {t("explore.tabPapers")}
                      </Link>
                    )}
                  </div>
                </div>
              ) : (
                <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 xl:grid-cols-3">
                  {view.map((doc) => (
                    <DocumentCard key={doc.id} doc={doc} actions={actionsOf(doc)} />
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </div>

      <NameDialog
        open={toRename !== null}
        title={t("library.renameTitle")}
        label={t("library.newTitle")}
        initial={toRename?.title ?? ""}
        maxLength={MAX_DOCUMENT_TITLE}
        busy={update.isPending}
        error={renameError}
        onSave={(title) => void rename(title)}
        onClose={() => setToRename(null)}
      />

      <NameDialog
        open={shelfName !== null}
        title={t(shelfName?.collection ? "library.renameCollectionTitle" : "library.newCollection")}
        label={t("library.collectionName")}
        initial={shelfName?.collection?.name ?? ""}
        maxLength={MAX_COLLECTION_NAME}
        busy={createCollection.isPending || renameCollection.isPending}
        error={shelfError}
        onSave={(name) => void saveShelf(name)}
        onClose={() => setShelfName(null)}
      />

      <CitationDialog doc={toCite} onClose={() => setToCite(null)} />
      <MoveDialog doc={toMove} collections={shelves} onClose={() => setToMove(null)} />
      <AddToNotebookDialog doc={toLink} onClose={() => setToLink(null)} />

      <RemoveDialog
        doc={toDelete}
        busy={del.isPending}
        onCancel={() => setToDelete(null)}
        onConfirm={() => void confirmDelete()}
      />

      <ConfirmDialog
        open={shelfToDelete !== null}
        title={t("library.deleteCollectionTitle")}
        busy={deleteCollection.isPending}
        onConfirm={() => void confirmDeleteShelf()}
        onCancel={() => setShelfToDelete(null)}
      >
        {t("library.deleteCollectionBody", { name: shelfToDelete?.name ?? "", n: shelfToDelete?.document_count ?? 0 })}
      </ConfirmDialog>

      <ConfirmDialog
        open={toShare !== null}
        title={t("library.shareOriginal")}
        tone="primary"
        confirmLabel={t(toShare?.url ? "library.shareLink" : "library.writeInstead")}
        cancelLabel={t("common.cancel")}
        busy={createPost.isPending}
        onCancel={() => setToShare(null)}
        onConfirm={() => {
          const doc = toShare;
          setToShare(null);
          if (doc) void startPost(doc, doc.url ? "link" : noDerivatives(doc.license) ? "insight" : "summary");
        }}
      >
        {t(toShare?.url ? "library.shareLinkBody" : "library.shareUploadBody")}
      </ConfirmDialog>
    </div>
  );
}

"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";

import { CitationDialog } from "@/components/citation-dialog";
import { Icon } from "@/components/icons";
import { DocumentRow, InfoPanel, ReadTabs, type DocActions } from "@/components/library-list";
import { Alert, ConfirmDialog, Spinner, useModal } from "@/components/ui";
import { useHighlights } from "@/lib/annotations";
import { BIBTEX_MIME, bibFileName, bibtex } from "@/lib/citation";
import { progressLabel, progressOf } from "@/lib/doc-view";
import { MAX_DOCUMENT_TITLE, useDeleteDocument, useDocuments, useUpdateDocument } from "@/lib/documents";
import { downloadText } from "@/lib/export";
import { useLang, useMsg, useT, type Key, type T } from "@/lib/i18n";
import {
  MAX_COLLECTION_NAME,
  NO_FILTERS,
  continueReading,
  filterDocuments,
  readCounts,
  stepSelection,
  useCollections,
  useCreateCollection,
  useDeleteCollection,
  useDocumentUsage,
  useMoveDocument,
  useRenameCollection,
  type Collection,
  type LibraryFilters,
} from "@/lib/library";
import { MSG } from "@/lib/messages";
import type { DocumentListItem } from "@/lib/types";
import { useUi } from "@/lib/ui-store";

type Sort = "recent" | "title" | "progress";
/** The left sidebar: everything, or one shelf. */
type Place = { kind: "all" } | { kind: "collection"; id: string };

const SORT_LABEL: Record<Sort, Key> = {
  recent: "library.sortRecentShort",
  title: "library.sortTitleShort",
  progress: "library.sortProgress",
};
const SORT_NEXT: Record<Sort, Sort> = { recent: "title", title: "progress", progress: "recent" };
const FILE_TYPES = ["web", "pdf", "epub"] as const;
type FileType = (typeof FILE_TYPES)[number];
/** The kinds of document, as the sidebar names them. */
const TYPE_ROW: Record<FileType, { label: Key; icon: "link" | "file" | "bookmark" }> = {
  web: { label: "library.typeWeb", icon: "link" },
  pdf: { label: "library.typePdf", icon: "file" },
  epub: { label: "library.typeEpub", icon: "bookmark" },
};
const FILTER_SELECT =
  "h-9 rounded-full border border-line bg-surface pl-3 pr-8 text-[13px] font-medium text-ink outline-none focus:border-focus";

type CardActions = DocActions;

/** F-16: the card's "⋯" menu. Closes on Escape, on a click outside and after a choice. */
function CardMenu({ doc, actions, row = false }: { doc: DocumentListItem; actions: CardActions; row?: boolean }) {
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
    <div ref={root} className={row ? "relative" : "absolute right-1.5 top-1.5 z-10 has-[[role=menu]]:z-30"} onKeyDown={onKeyDown}>
      <button
        ref={button}
        type="button"
        onClick={() => setOpen(!open)}
        aria-label={t("library.cardMenu", { title: doc.title })}
        aria-haspopup="menu"
        aria-expanded={open}
        className={`flex items-center justify-center rounded-[10px] opacity-70 transition hover:opacity-100 aria-expanded:opacity-100 ${
          row ? "h-9 w-9 hover:bg-soft aria-expanded:bg-soft" : "h-11 w-11 hover:bg-surface/60 aria-expanded:bg-surface/60"
        }`}
      >
        <Icon name="more" />
      </button>
      {open && (
        <div
          role="menu"
          aria-label={doc.title}
          className={`mobile-action-menu absolute right-0 z-20 flex w-60 flex-col gap-0.5 rounded-xl border border-line bg-surface p-1.5 text-ink shadow-float ${
            row ? "top-10" : "top-12"
          }`}
        >
          <Link href={`/reader/${doc.id}`} role="menuitem" className={item}>
            <Icon name="book" size={16} />
            {t("library.readAction")}
          </Link>
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
            {data.notebooks > 0 && (
              <>
                <span className="font-semibold text-ink">{t("library.removeKept")}</span>
                <span>• {t("library.removeNotebooks", { n: data.notebooks })}</span>
              </>
            )}
          </>
        )}
      </span>
    </ConfirmDialog>
  );
}

/** Where the reader left off, in one line above the list. */
function ContinueStrip({ doc }: { doc: DocumentListItem }) {
  const t = useT();
  const pct = progressOf(doc);
  return (
    <Link
      href={`/reader/${doc.id}`}
      className="group flex items-center gap-3 rounded-xl border border-line bg-surface px-4 py-2.5 shadow-card transition-colors hover:border-accent"
    >
      <span className="eyebrow shrink-0">{t("library.continue")}</span>
      <span className="min-w-0 flex-1 truncate text-[15px] font-semibold text-ink">{doc.title}</span>
      <span className="hidden shrink-0 text-[13px] text-muted md:inline">{progressLabel(doc, pct)}</span>
      <span className="flex shrink-0 items-center gap-1 text-sm font-semibold text-accent-text">
        {t("library.continueRead")}
        <Icon name="arrow" size={16} />
      </span>
    </Link>
  );
}

function Sidebar({
  place,
  onPlace,
  fileType,
  onFileType,
  types,
  total,
  highlights,
  collections,
  onNew,
  onRename,
  onDelete,
}: {
  place: Place;
  onPlace: (place: Place) => void;
  /** The kind being shown, within "all documents". */
  fileType: FileType | "all";
  onFileType: (type: FileType) => void;
  types: { type: FileType; count: number }[];
  total: number;
  highlights: number;
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
  const [collectionsOpen, setCollectionsOpen] = useState(false);
  const collectionDialog = useModal(collectionsOpen);
  return (
    <nav aria-label={t("library.sections")} className="library-categories flex flex-col gap-1 lg:sticky lg:top-[96px] lg:self-start">
      <button
        type="button"
        className={row(place.kind === "all" && fileType === "all")}
        aria-pressed={place.kind === "all" && fileType === "all"}
        onClick={() => onPlace({ kind: "all" })}
      >
        <Icon name="book" size={16} className="shrink-0" />
        <span className="flex-1 truncate">{t("library.allDocuments")}</span>
        <span className={count}>{total}</span>
      </button>
      {types.length > 1 &&
        types.map(({ type, count: n }) => {
          const active = place.kind === "all" && fileType === type;
          return (
            <button key={type} type="button" className={`${row(active)} pl-6`} aria-pressed={active} onClick={() => onFileType(type)}>
              <Icon name={TYPE_ROW[type].icon} size={15} className="shrink-0" />
              <span className="flex-1 truncate">{t(TYPE_ROW[type].label)}</span>
              <span className={count}>{n}</span>
            </button>
          );
        })}
      <Link href="/highlights" className={row(false)}>
        <Icon name="highlighter" size={16} className="shrink-0" />
        <span className="flex-1 truncate">{t("library.highlights")}</span>
        <span className={count}>{highlights}</span>
      </Link>
      <button type="button" className="chip shrink-0 lg:hidden" onClick={() => setCollectionsOpen(true)}>{t("library.collections")}</button>
      <dialog ref={collectionDialog} aria-label={t("library.collections")} onCancel={() => setCollectionsOpen(false)} onClick={(e) => { if(e.target === e.currentTarget) setCollectionsOpen(false); }} className="dialog mobile-collections lg:hidden">
        <div className="flex flex-col gap-2 p-4">
          <button type="button" className="btn-outline" onClick={() => setCollectionsOpen(false)}>{t("common.close")}</button>
          {collections.map((c) => <div key={c.id} className="flex items-center gap-1">
            <button className="btn-ghost min-w-0 flex-1 justify-start truncate" onClick={() => { onPlace({ kind: "collection", id: c.id }); setCollectionsOpen(false); }}>{c.name} · {c.document_count}</button>
            <button className="icon-btn" aria-label={t("library.renameCollection", { name: c.name })} onClick={() => { setCollectionsOpen(false); onRename(c); }}><Icon name="pencil" size={16} /></button>
            <button className="icon-btn" aria-label={t("library.deleteCollection", { name: c.name })} onClick={() => { setCollectionsOpen(false); onDelete(c); }}><Icon name="x" size={16} /></button>
          </div>)}
          <button className="btn-outline" onClick={() => { setCollectionsOpen(false); onNew(); }}>{t("library.newCollection")}</button>
        </div>
      </dialog>
      <div className="hidden lg:contents">
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
      </div>
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
  const del = useDeleteDocument();
  const update = useUpdateDocument();
  const createCollection = useCreateCollection();
  const renameCollection = useRenameCollection();
  const deleteCollection = useDeleteCollection();
  const [toRename, setToRename] = useState<DocumentListItem | null>(null);
  const [renameError, setRenameError] = useState<string | null>(null);
  const [toCite, setToCite] = useState<DocumentListItem | null>(null);
  const [toMove, setToMove] = useState<DocumentListItem | null>(null);
  const [toDelete, setToDelete] = useState<DocumentListItem | null>(null);
  const [shelfName, setShelfName] = useState<{ collection: Collection | null } | null>(null);
  const [shelfError, setShelfError] = useState<string | null>(null);
  const [shelfToDelete, setShelfToDelete] = useState<Collection | null>(null);
  const { setAddOpen, showToast } = useUi();
  const { data: highlights } = useHighlights();
  const [actionError, setActionError] = useState<string | null>(null);
  // The row the panel is about: where the pointer is, or where the arrow keys have gone.
  const [picked, setPicked] = useState<string | null>(null);
  const keyAt = useRef(0);
  const t: T = useT();
  const msg = useMsg();
  const lang = useLang();

  const docs = useMemo(() => data ?? [], [data]);
  const shelves = useMemo(() => collections.data ?? [], [collections.data]);
  const readingCount = docs.filter((d) => {
    const p = progressOf(d);
    return p > 0 && p < 100;
  }).length;
  const docIds = new Set(docs.map((d) => d.id));
  const hlCount = highlights.filter((h) => docIds.has(h.docId)).length;
  const topics = useMemo(() => [...new Set(docs.flatMap((d) => d.topics))].sort(), [docs]);
  const types = FILE_TYPES.map((type) => ({ type, count: docs.filter((d) => d.file_type === type).length })).filter((x) => x.count > 0);

  // A shelf that was just deleted is no longer somewhere to be.
  const shelf = place.kind === "collection" ? shelves.find((c) => c.id === place.id) ?? null : null;
  const collectionId = shelf?.id ?? null;
  // Everything narrowed down but the reading state: what the tabs count.
  const scoped = filterDocuments(docs, { ...filters, collection: collectionId, readState: "all" });
  const tabCounts = readCounts(scoped);
  const view = filterDocuments(scoped, { ...NO_FILTERS, readState: filters.readState }).sort((a, b) => {
    if (sort === "title") return a.title.localeCompare(b.title, lang);
    if (sort === "progress") return progressOf(b) - progressOf(a);
    return b.updated_at.localeCompare(a.updated_at);
  });
  // Narrowed by something other than a tab: an empty list then means "no match", not "nothing here yet".
  const narrowed = filters.fileType !== "all" || Boolean(filters.topic) || Boolean(filters.query.trim());
  const filtered = narrowed || filters.readState !== "all";
  const atHome = place.kind === "all" && !filtered;
  const continuing = atHome ? continueReading(docs, 1).filter((d) => progressOf(d) > 0) : [];
  const selectedId = picked !== null && view.some((d) => d.id === picked) ? picked : (view[0]?.id ?? null);
  const selected = view.find((d) => d.id === selectedId) ?? null;

  const patchFilters = (patch: Partial<LibraryFilters>) => setFilters((f) => ({ ...f, ...patch }));
  const goTo = (next: Place) => {
    setPlace(next);
    patchFilters({ fileType: "all" });
  };
  const showType = (type: FileType) => {
    setPlace({ kind: "all" });
    patchFilters({ fileType: type });
  };
  /** The pointer chooses a row, unless the list has just moved under it because of the keyboard. */
  const pickByPointer = (id: string) => {
    if (Date.now() - keyAt.current > 500) setPicked(id);
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

  // The list answers the keyboard: ↑ ↓ (or J K) choose a row, Enter (or O) opens it, E marks it read or unread.
  // Set up again on each render so that it always sees the list as it is now.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.ctrlKey || e.metaKey || e.altKey || document.querySelector("dialog[open]")) return;
      const el = e.target instanceof HTMLElement ? e.target : null;
      if (el?.closest("input, textarea, select, [role=menu], [contenteditable=true]")) return;
      const step = e.key === "ArrowDown" || e.key === "j" ? 1 : e.key === "ArrowUp" || e.key === "k" ? -1 : 0;
      if (step) {
        const next = stepSelection(
          view.map((d) => d.id),
          selectedId,
          step,
        );
        if (next === null) return;
        e.preventDefault();
        keyAt.current = Date.now();
        setPicked(next);
        document.querySelector(`[data-doc="${next}"]`)?.scrollIntoView({ block: "nearest" });
        return;
      }
      // On a button or a link, Enter and letters belong to it.
      if (!selected || el?.closest("button, a")) return;
      if (e.key === "Enter" || e.key === "o") {
        e.preventDefault();
        router.push(`/reader/${selected.id}`);
      } else if (e.key === "e") {
        e.preventDefault();
        void toggleRead(selected);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

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
    <div className="mx-auto flex max-w-[1440px] flex-col gap-5">
      <div className="flex flex-wrap items-end gap-x-4 gap-y-2">
        <h1 className="page-title">{t("nav.library")}</h1>
        {docs.length > 0 && (
          <p className="pb-1.5 text-sm text-muted">{t("library.stats", { docs: docs.length, reading: readingCount, hl: hlCount })}</p>
        )}
        <span className="flex-1" />
        {docs.length > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            {topics.length > 0 && (
              <label>
                <span className="sr-only">{t("library.filterTopic")}</span>
                <select value={filters.topic} onChange={(e) => patchFilters({ topic: e.target.value })} className={FILTER_SELECT}>
                  <option value="">{t("library.allTopics")}</option>
                  {topics.map((x) => (
                    <option key={x} value={x}>
                      {t(`feed.topic.${x}` as Key)}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label className="flex h-9 w-full items-center gap-2 rounded-full border border-line bg-surface px-3 text-muted focus-within:border-focus sm:w-[260px]">
              <Icon name="search" size={15} />
              <span className="sr-only">{t("library.filterName")}</span>
              <input
                value={filters.query}
                onChange={(e) => patchFilters({ query: e.target.value })}
                placeholder={t("library.filterPlaceholder")}
                className="min-w-0 flex-1 bg-transparent text-[13px] text-ink outline-none"
              />
            </label>
          </div>
        )}
        {/* On a wide screen the menu column already has this button. */}
        <button type="button" className="btn-primary lg:hidden" onClick={() => setAddOpen(true)}>
          <Icon name="plus" />
          {t("nav.addDocument")}
        </button>
      </div>

      {actionError && <Alert>{actionError}</Alert>}

      {continuing.length > 0 && <div className="lg:hidden"><ContinueStrip doc={continuing[0]} /></div>}
      <div className="grid gap-6 lg:grid-cols-[200px_minmax(0,1fr)] lg:gap-7 min-[1400px]:grid-cols-[200px_minmax(0,1fr)_300px]">
        <Sidebar
          place={place}
          onPlace={goTo}
          fileType={filters.fileType}
          onFileType={showType}
          types={types}
          total={docs.length}
          highlights={hlCount}
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

        <div className="flex min-w-0 flex-col gap-4">
          {shelf && <h2 className="font-display text-2xl font-semibold">{shelf.name}</h2>}
          {continuing.length > 0 && <div className="hidden lg:block"><ContinueStrip doc={continuing[0]} /></div>}

          <div className="flex flex-wrap items-end gap-x-4 border-b border-line">
            <ReadTabs value={filters.readState} counts={tabCounts} onChange={(readState) => patchFilters({ readState })} />
            <span className="flex-1" />
            <div className="flex shrink-0 items-center gap-2 py-1.5">
              <button
                type="button"
                className="chip h-9 px-3 text-[13px]"
                onClick={() => setSort(SORT_NEXT[sort])}
                aria-label={t("library.sortLabel", { sort: t(SORT_LABEL[sort]) })}
                title={t("library.sortLabel", { sort: t(SORT_LABEL[sort]) })}
              >
                <Icon name="sort" size={15} />
                {/* Beside the panel the list is narrow, and the tabs need the room more than this word does. */}
                <span className="min-[1400px]:max-[1599px]:hidden">{t(SORT_LABEL[sort])}</span>
              </button>
              {view.length > 0 && (
                <button
                  type="button"
                  className="icon-btn h-9 w-9 border border-line bg-surface"
                  onClick={exportBibtex}
                  aria-label={t("library.exportBib")}
                  title={t("library.exportBibHint", { n: view.length })}
                >
                  <Icon name="download" size={16} />
                </button>
              )}
            </div>
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
                {narrowed ? t("library.noMatch") : filtered ? t("library.tabEmpty") : shelf ? t("library.shelfEmpty") : msg("MSG-30")}
              </span>
              <span className="max-w-md text-[15px] text-muted">
                {t(narrowed ? "library.noMatchHint" : filtered ? "library.tabEmptyHint" : shelf ? "library.shelfEmptyHint" : "library.emptyHintLong")}
              </span>
              <div className="flex gap-2.5">
                {filtered && (
                  <button type="button" className="btn-outline" onClick={() => setFilters(NO_FILTERS)}>
                    {t(narrowed ? "library.clearFilters" : "library.showAll")}
                  </button>
                )}
                {!shelf && !filtered && (
                  <button type="button" className="btn-primary" onClick={() => setAddOpen(true)}>
                    {t("nav.addDocument")}
                  </button>
                )}
                {!filtered && !shelf && (
                  <Link href="/explore" className="btn-outline">
                    {t("nav.explore")}
                  </Link>
                )}
              </div>
            </div>
          ) : (
            <ul aria-label={t("library.listAria")} className="-mt-4 flex flex-col">
              {view.map((doc) => {
                const actions = actionsOf(doc);
                return (
                  <DocumentRow
                    key={doc.id}
                    doc={doc}
                    selected={doc.id === selectedId}
                    onSelect={() => pickByPointer(doc.id)}
                    actions={actions}
                    menu={<CardMenu doc={doc} actions={actions} row />}
                  />
                );
              })}
            </ul>
          )}
        </div>

        <InfoPanel
          doc={selected}
          shelf={selected ? (shelves.find((c) => c.id === selected.collection_id)?.name ?? null) : null}
          highlights={selected ? highlights.filter((h) => h.docId === selected.id).length : 0}
          actions={selected ? actionsOf(selected) : null}
        />
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
    </div>
  );
}

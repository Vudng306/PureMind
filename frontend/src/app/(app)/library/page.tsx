"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";

import { Icon } from "@/components/icons";
import { Alert, ConfirmDialog, Spinner, useModal } from "@/components/ui";
import { useHighlights } from "@/lib/annotations";
import {
  KIND_CLASS,
  KIND_LABEL,
  isProcessing,
  origin,
  progressLabel,
  progressOf,
  readStateOf,
  relativeTime,
  type ReadState,
} from "@/lib/doc-view";
import { MAX_DOCUMENT_TITLE, useDeleteDocument, useDocuments, useUpdateDocument } from "@/lib/documents";
import { normalize } from "@/lib/find";
import { MSG, messageFor } from "@/lib/messages";
import type { DocumentListItem } from "@/lib/types";
import { useUi } from "@/lib/ui-store";

type Source = "all" | "upload" | "manual";
type Sort = "recent" | "title" | "progress";

const SORT_LABEL: Record<Sort, string> = { recent: "Gần đây", title: "Tên A–Z", progress: "Tiến độ" };
const SORT_NEXT: Record<Sort, Sort> = { recent: "title", title: "progress", progress: "recent" };
const READ_LABEL: Record<ReadState | "all", string> = {
  all: "Mọi trạng thái",
  unread: "Chưa đọc",
  reading: "Đang đọc",
  read: "Đã đọc xong",
};

/** F-16: the card's "⋯" menu. Closes on Escape, on a click outside and after a choice. */
function CardMenu({
  doc,
  onRename,
  onToggleRead,
  onDelete,
}: {
  doc: DocumentListItem;
  onRename: () => void;
  onToggleRead: () => void;
  onDelete: () => void;
}) {
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
        aria-label={`Tùy chọn cho ${doc.title}`}
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
          className="absolute right-0 top-12 flex w-56 flex-col gap-0.5 rounded-xl border border-line bg-surface p-1.5 text-ink shadow-float"
        >
          <button type="button" role="menuitem" className={item} onClick={choose(onRename)}>
            <Icon name="pencil" size={16} />
            Đổi tên
          </button>
          <button type="button" role="menuitem" className={item} onClick={choose(onToggleRead)}>
            <Icon name={doc.is_read ? "minus" : "check"} size={16} />
            {doc.is_read ? "Đánh dấu chưa đọc" : "Đánh dấu đã đọc"}
          </button>
          <button type="button" role="menuitem" className={`${item} text-danger`} onClick={choose(onDelete)}>
            <Icon name="trash" size={16} />
            Xóa
          </button>
        </div>
      )}
    </div>
  );
}

function RenameDialog({
  doc,
  busy,
  error,
  onSave,
  onClose,
}: {
  doc: DocumentListItem | null;
  busy: boolean;
  error: string | null;
  onSave: (title: string) => void;
  onClose: () => void;
}) {
  const ref = useModal(doc !== null);
  const [title, setTitle] = useState("");
  useEffect(() => {
    if (doc) setTitle(doc.title);
  }, [doc]);
  const clean = title.split(/\s+/).filter(Boolean).join(" ");
  const ok = clean.length > 0 && clean !== doc?.title;

  return (
    <dialog
      ref={ref}
      aria-label="Đổi tên tài liệu"
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
        <h2 className="font-serif text-2xl font-medium">Đổi tên tài liệu</h2>
        <label className="flex flex-col gap-1.5">
          <span className="text-sm text-muted">Tên mới</span>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={MAX_DOCUMENT_TITLE}
            className="h-11 rounded-lg border border-field bg-surface px-3 text-[15px] text-ink outline-none focus:border-accent"
          />
        </label>
        {!clean && <span className="text-sm text-danger">Tên tài liệu không được để trống.</span>}
        {error && <Alert>{error}</Alert>}
        <div className="mt-1.5 flex justify-end gap-2.5">
          <button type="button" className="btn-outline" onClick={onClose} disabled={busy}>
            Hủy
          </button>
          <button type="submit" className="btn-primary" disabled={!ok || busy}>
            {busy ? "Đang lưu…" : "Lưu"}
          </button>
        </div>
      </form>
    </dialog>
  );
}

function DocumentCard({ doc, pct, menu }: { doc: DocumentListItem; pct: number; menu: React.ReactNode }) {
  const failed = doc.extraction_status === "failed";
  const processing = isProcessing(doc);
  const initial = doc.title.trim().charAt(0).toUpperCase() || "?";

  return (
    <article className="group relative flex flex-col rounded-xl border border-line bg-surface transition-shadow hover:shadow-float">
      <div className={`relative flex h-[150px] items-center justify-center rounded-t-xl ${KIND_CLASS[doc.file_type]}`}>
        <span aria-hidden className="font-serif text-[72px] leading-none">
          {initial}
        </span>
        <span className="absolute left-3 top-3 flex h-6 items-center rounded bg-surface px-2 text-xs font-semibold">
          {KIND_LABEL[doc.file_type]}
        </span>
        {menu}
      </div>
      <div className="flex flex-1 flex-col gap-1.5 p-4">
        <Link
          href={`/reader/${doc.id}`}
          className="line-clamp-2 font-serif text-[19px] font-medium leading-[1.3] after:absolute after:inset-0 hover:underline"
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
            <span className="text-[13px] text-muted">Đang trích xuất văn bản…</span>
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
              <span className="btn-outline pointer-events-none px-4 text-sm font-semibold">{failed ? "Xem bản gốc" : "Đọc"}</span>
            </div>
          </div>
        )}
      </div>
    </article>
  );
}

export default function LibraryPage() {
  const [sort, setSort] = useState<Sort>("recent");
  const [source, setSource] = useState<Source>("all");
  const [readState, setReadState] = useState<ReadState | "all">("all");
  const [query, setQuery] = useState("");
  const { data, isLoading, isError, error, refetch } = useDocuments("created_desc");
  const del = useDeleteDocument();
  const update = useUpdateDocument();
  const [toRename, setToRename] = useState<DocumentListItem | null>(null);
  const [renameError, setRenameError] = useState<string | null>(null);
  const { setAddOpen, showToast } = useUi();
  const { data: highlights } = useHighlights();
  const [actionError, setActionError] = useState<string | null>(null);
  const [toDelete, setToDelete] = useState<DocumentListItem | null>(null);

  const docs = useMemo(() => data ?? [], [data]);
  const pctOf = (d: DocumentListItem) => progressOf(d);

  const counts = {
    all: docs.length,
    upload: docs.filter((d) => d.source_type === "upload").length,
    manual: docs.filter((d) => d.source_type === "manual").length,
  };
  const readingCount = docs.filter((d) => {
    const p = pctOf(d);
    return p > 0 && p < 100;
  }).length;
  const docIds = new Set(docs.map((d) => d.id));
  const hlCount = highlights.filter((h) => docIds.has(h.docId)).length;

  const q = normalize(query.trim());
  const view = docs
    .filter((d) => source === "all" || d.source_type === source)
    .filter((d) => readState === "all" || readStateOf(d) === readState)
    .filter((d) => !q || normalize(`${d.title} ${origin(d)}`).includes(q))
    .sort((a, b) => {
      if (sort === "title") return a.title.localeCompare(b.title, "vi");
      if (sort === "progress") return pctOf(b) - pctOf(a);
      return b.updated_at.localeCompare(a.updated_at);
    });

  // "Đọc tiếp": the most recently touched document that is started but not finished.
  const readable = docs.filter((d) => d.extraction_status === "done" || (d.file_type === "pdf" && !isProcessing(d)));
  const cont =
    [...readable]
      .filter((d) => {
        const p = pctOf(d);
        return p > 0 && p < 100;
      })
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0] ?? readable.find((d) => !d.is_read);
  const contPct = cont ? pctOf(cont) : 0;

  async function confirmDelete() {
    if (!toDelete) return;
    const doc = toDelete;
    try {
      await del.mutateAsync(doc.id);
      showToast(`Đã xóa “${doc.title}”`);
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
      showToast("Đã đổi tên tài liệu");
    } catch (err) {
      setRenameError(err instanceof Error ? err.message : MSG["MSG-99"]);
    }
  }

  async function toggleRead(doc: DocumentListItem) {
    setActionError(null);
    try {
      await update.mutateAsync({ id: doc.id, patch: { is_read: !doc.is_read } });
      showToast(doc.is_read ? "Đã đánh dấu chưa đọc" : "Đã đánh dấu đã đọc");
    } catch (err) {
      setActionError(err instanceof Error ? err.message : MSG["MSG-99"]);
    }
  }

  const filtered = source !== "all" || readState !== "all" || Boolean(q);

  return (
    <div className="mx-auto flex max-w-[1200px] flex-col gap-8">
      <div className="flex flex-col gap-2">
        <h1 className="font-serif text-4xl font-medium leading-[1.1] sm:text-5xl">Hôm nay bạn muốn đọc gì?</h1>
        {docs.length > 0 && (
          <p className="text-base text-muted">
            {docs.length} tài liệu · {readingCount} đang đọc · {hlCount} highlight
          </p>
        )}
      </div>

      {actionError && <Alert>{actionError}</Alert>}

      {cont && (
        <section className="overflow-hidden rounded-[14px] border border-line bg-surface">
          <div className="flex flex-col gap-3.5 px-6 py-7 sm:px-9 sm:py-8">
            <span className="eyebrow">ĐỌC TIẾP</span>
            <span className="line-clamp-3 font-serif text-3xl font-medium leading-[1.15] sm:text-4xl">{cont.title}</span>
            <span className="text-[15px] text-muted">
              {KIND_LABEL[cont.file_type]} · {origin(cont)} · {progressLabel(cont, contPct)}
            </span>
            <span className="h-1.5 w-full max-w-[360px] rounded-[3px] bg-soft">
              <span className="block h-1.5 rounded-[3px] bg-accent" style={{ width: `${contPct}%` }} />
            </span>
            <Link href={`/reader/${cont.id}`} className="btn-dark mt-1.5 h-12 self-start px-[22px]">
              {contPct > 0 ? "Đọc tiếp" : "Bắt đầu đọc"}
              <Icon name="arrow" />
            </Link>
          </div>
        </section>
      )}

      <div className="flex flex-wrap items-center gap-2.5">
        {(
          [
            ["all", "Tất cả"],
            ["upload", "Tải lên"],
            ["manual", "Link"],
          ] as const
        ).map(([value, label]) => (
          <button key={value} type="button" className="chip" aria-pressed={source === value} onClick={() => setSource(value)}>
            {label} · {counts[value]}
          </button>
        ))}
        <span className="hidden flex-1 sm:block" />
        <label className="flex h-10 w-full items-center gap-2 rounded-full border border-field bg-surface px-3 text-muted focus-within:border-accent sm:w-[280px]">
          <Icon name="search" size={16} />
          <span className="sr-only">Lọc theo tên</span>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Lọc theo tên hoặc nguồn"
            className="min-w-0 flex-1 bg-transparent text-sm text-ink outline-none"
          />
        </label>
        <label>
          <span className="sr-only">Trạng thái đọc</span>
          <select
            value={readState}
            onChange={(e) => setReadState(e.target.value as ReadState | "all")}
            className="h-10 rounded-full border border-field bg-surface pl-3.5 pr-8 text-sm text-ink outline-none focus:border-accent"
          >
            {(Object.keys(READ_LABEL) as (ReadState | "all")[]).map((value) => (
              <option key={value} value={value}>
                {READ_LABEL[value]}
              </option>
            ))}
          </select>
        </label>
        <button type="button" className="chip" onClick={() => setSort(SORT_NEXT[sort])} aria-label={`Sắp xếp: ${SORT_LABEL[sort]}`}>
          <Icon name="sort" size={16} />
          {SORT_LABEL[sort]}
        </button>
      </div>

      {isLoading ? (
        <Spinner />
      ) : isError ? (
        <div className="flex flex-col items-start gap-3">
          <Alert>{error instanceof Error ? error.message : MSG["MSG-99"]}</Alert>
          <button type="button" className="btn-outline" onClick={() => refetch()}>
            Thử lại
          </button>
        </div>
      ) : view.length === 0 ? (
        <div className="flex flex-col items-center gap-3.5 rounded-[14px] border border-dashed border-field px-6 py-16 text-center">
          <span className="font-serif text-[28px]">{filtered ? "Không có tài liệu nào khớp" : MSG["MSG-30"]}</span>
          <span className="max-w-md text-[15px] text-muted">
            {filtered
              ? "Thử từ khóa khác hoặc thêm tài liệu mới."
              : "Tải lên giáo trình, bài báo, ebook (PDF, EPUB tối đa 50 MB) hoặc lưu một bài viết từ link để bắt đầu đọc."}
          </span>
          <div className="flex gap-2.5">
            {filtered && (
              <button
                type="button"
                className="btn-outline"
                onClick={() => {
                  setQuery("");
                  setSource("all");
                  setReadState("all");
                }}
              >
                Xóa bộ lọc
              </button>
            )}
            <button type="button" className="btn-primary" onClick={() => setAddOpen(true)}>
              Thêm tài liệu
            </button>
          </div>
        </div>
      ) : (
        <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {view.map((doc) => (
            <DocumentCard
              key={doc.id}
              doc={doc}
              pct={pctOf(doc)}
              menu={
                <CardMenu
                  doc={doc}
                  onRename={() => {
                    setRenameError(null);
                    setToRename(doc);
                  }}
                  onToggleRead={() => void toggleRead(doc)}
                  onDelete={() => setToDelete(doc)}
                />
              }
            />
          ))}
        </div>
      )}

      <RenameDialog
        doc={toRename}
        busy={update.isPending}
        error={renameError}
        onSave={(title) => void rename(title)}
        onClose={() => setToRename(null)}
      />

      <ConfirmDialog
        open={toDelete !== null}
        title="Xóa tài liệu này?"
        busy={del.isPending}
        onCancel={() => setToDelete(null)}
        onConfirm={confirmDelete}
      >
        “{toDelete?.title}” cùng tệp gốc, highlight và ghi chú sẽ bị xóa vĩnh viễn.
      </ConfirmDialog>
    </div>
  );
}

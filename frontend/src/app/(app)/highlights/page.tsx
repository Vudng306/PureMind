"use client";

import { useInfiniteQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useMemo, useState } from "react";

import { Icon } from "@/components/icons";
import { Alert, Spinner } from "@/components/ui";
import {
  CATEGORIES,
  CATEGORY_LABEL,
  fromDto,
  highlightsKey,
  type HighlightCategory,
  type HighlightPage,
} from "@/lib/annotations";
import { api } from "@/lib/api";
import { KIND_LABEL, relativeTime } from "@/lib/doc-view";
import { useDocuments } from "@/lib/documents";
import { downloadText, exportFileName, fetchAllHighlights, highlightsMarkdown } from "@/lib/export";
import { MSG } from "@/lib/messages";
import { COLOR_DOT, HIGHLIGHT_COLORS, colorLabel, usePreferences, type HighlightColor } from "@/lib/preferences";

const PAGE_SIZE = 50;
const NOTE_PREVIEW = 200;
type Sort = "newest" | "document";

const selectCls =
  "h-10 max-w-full rounded-full border border-field bg-surface pl-3.5 pr-8 text-sm text-ink outline-none focus:border-accent";

/** FR-HL-05: every highlight across the library, filtered and sorted, 50 at a time. */
export default function HighlightsPage() {
  const labels = usePreferences((s) => s.colorLabels);
  const { data: docs } = useDocuments("created_desc");
  const [docId, setDocId] = useState("");
  const [category, setCategory] = useState<HighlightCategory | "">("");
  const [color, setColor] = useState<HighlightColor | "">("");
  const [sort, setSort] = useState<Sort>("newest");

  const docById = useMemo(() => new Map((docs ?? []).map((d) => [d.id, d])), [docs]);

  const query = useInfiniteQuery({
    queryKey: [...highlightsKey, "page", { docId, category, color, sort }],
    initialPageParam: 1,
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({ sort, page: String(pageParam), page_size: String(PAGE_SIZE) });
      if (docId) params.set("document_id", docId);
      if (category) params.set("category", category);
      if (color) params.set("color", color);
      return api<HighlightPage>(`/highlights?${params}`);
    },
    getNextPageParam: (last, pages) => (pages.length * PAGE_SIZE < last.total ? pages.length + 1 : undefined),
  });

  const items = query.data?.pages.flatMap((p) => p.items.map(fromDto)) ?? [];
  const total = query.data?.pages[0]?.total ?? 0;
  const filtered = Boolean(docId || category || color);

  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  /** F-35: every highlight matching the filters (not just the loaded pages), with notes, as a .md file. */
  async function exportMarkdown() {
    setExporting(true);
    setExportError(null);
    try {
      const filter = { documentId: docId || undefined, category: category || undefined, color: color || undefined };
      const all = await fetchAllHighlights(filter);
      const now = new Date();
      downloadText(highlightsMarkdown(all, docById, labels, filter, now), exportFileName(docById.get(docId)?.title ?? null, now));
    } catch (e) {
      setExportError(e instanceof Error ? e.message : MSG["MSG-99"]);
    } finally {
      setExporting(false);
    }
  }

  function reset() {
    setDocId("");
    setCategory("");
    setColor("");
  }

  return (
    <div className="mx-auto flex max-w-[880px] flex-col gap-7">
      <div className="flex flex-wrap items-end gap-4">
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <h1 className="font-serif text-4xl font-medium leading-[1.1] sm:text-5xl">Highlight</h1>
          <p className="text-base text-muted">
            {query.isSuccess ? `${total} highlight${filtered ? " khớp bộ lọc" : ""}` : "Những đoạn bạn đã đánh dấu khi đọc."}
          </p>
        </div>
        {total > 0 && (
          <div className="flex flex-wrap gap-2.5">
            <button type="button" className="btn-outline" onClick={() => void exportMarkdown()} disabled={exporting}>
              <Icon name="download" size={16} />
              {exporting ? "Đang xuất…" : "Xuất Markdown"}
            </button>
            <Link href={docId ? `/notebooks/new?document=${docId}` : "/notebooks/new"} className="btn-outline">
              <Icon name="spark" size={16} />
              Tạo notebook AI
            </Link>
          </div>
        )}
      </div>

      {exportError && <Alert>{exportError}</Alert>}

      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2.5">
          <label className="min-w-0">
            <span className="sr-only">Tài liệu</span>
            <select value={docId} onChange={(e) => setDocId(e.target.value)} className={`${selectCls} w-[260px]`}>
              <option value="">Mọi tài liệu</option>
              {(docs ?? []).map((d) => (
                <option key={d.id} value={d.id}>
                  {d.title}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span className="sr-only">Danh mục</span>
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value as HighlightCategory | "")}
              className={selectCls}
            >
              <option value="">Mọi danh mục</option>
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {CATEGORY_LABEL[c]}
                </option>
              ))}
            </select>
          </label>
          <span className="hidden flex-1 sm:block" />
          <div className="flex h-10 gap-0.5 rounded-full bg-soft p-1" role="group" aria-label="Sắp xếp">
            {(
              [
                ["newest", "Mới nhất"],
                ["document", "Theo tài liệu"],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                aria-pressed={sort === value}
                onClick={() => setSort(value)}
                className={`rounded-full px-3.5 text-sm ${sort === value ? "bg-surface font-semibold text-ink shadow-sm" : "text-muted hover:text-ink"}`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        <div className="flex flex-wrap gap-1.5" aria-label="Lọc theo màu">
          <button type="button" className="chip h-9 px-3 text-[13px]" aria-pressed={!color} onClick={() => setColor("")}>
            Mọi màu
          </button>
          {HIGHLIGHT_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              className="chip h-9 gap-1.5 px-3 text-[13px]"
              aria-pressed={color === c}
              onClick={() => setColor(color === c ? "" : c)}
            >
              <span className="h-2.5 w-2.5 rounded-full" style={{ background: COLOR_DOT[c] }} />
              {colorLabel(labels, c)}
            </button>
          ))}
        </div>
      </div>

      {query.isPending ? (
        <Spinner />
      ) : query.isError ? (
        <div className="flex flex-col items-start gap-3">
          <Alert>{query.error instanceof Error ? query.error.message : MSG["MSG-99"]}</Alert>
          <button type="button" className="btn-outline" onClick={() => query.refetch()}>
            Thử lại
          </button>
        </div>
      ) : items.length === 0 ? (
        <div className="flex flex-col items-center gap-3.5 rounded-[14px] border border-dashed border-field px-6 py-16 text-center">
          <span className="font-serif text-[28px]">{filtered ? "Không có highlight nào khớp" : MSG["MSG-32"]}</span>
          <span className="max-w-md text-[15px] text-muted">
            {filtered
              ? "Thử bỏ bớt bộ lọc."
              : "Bôi đen một câu khi đọc ở chế độ Văn bản sạch để lưu lại ý chính, câu hỏi hay ví dụ."}
          </span>
          {filtered ? (
            <button type="button" className="btn-outline" onClick={reset}>
              Xóa bộ lọc
            </button>
          ) : (
            <Link href="/library" className="btn-primary">
              Mở thư viện
            </Link>
          )}
        </div>
      ) : (
        <ul className="flex flex-col gap-3">
          {items.map((h) => {
            const doc = docById.get(h.docId);
            const note = h.note.length > NOTE_PREVIEW ? `${h.note.slice(0, NOTE_PREVIEW).trimEnd()}…` : h.note;
            return (
              <li key={h.id}>
                <Link
                  href={`/reader/${h.docId}?hl=${h.id}`}
                  className="flex flex-col gap-2.5 rounded-xl border border-line bg-surface p-4 transition-shadow hover:shadow-float sm:p-5"
                >
                  <span className="flex flex-wrap items-center gap-2 text-xs text-muted">
                    <span className="flex h-6 items-center gap-1.5 rounded-full bg-soft pl-1.5 pr-2 font-semibold text-ink">
                      <span className="h-2.5 w-2.5 rounded-full" style={{ background: COLOR_DOT[h.color] }} />
                      {colorLabel(labels, h.color)}
                    </span>
                    {h.category && (
                      <span className="flex h-6 items-center rounded-full border border-ink px-2 font-semibold text-ink">
                        {CATEGORY_LABEL[h.category]}
                      </span>
                    )}
                    <span className="flex-1" />
                    {relativeTime(h.createdAt)}
                  </span>
                  <span className="line-clamp-6 font-serif text-[17px] leading-relaxed text-ink">
                    <span className={`box-decoration-clone hl-bg-${h.color}`}>{h.text}</span>
                  </span>
                  {note && (
                    <span className="whitespace-pre-wrap rounded-lg bg-soft px-3 py-2.5 text-sm leading-normal text-body">{note}</span>
                  )}
                  <span className="truncate text-[13px] text-muted">
                    {doc ? `${KIND_LABEL[doc.file_type]} · ${doc.title}` : "Tài liệu"}
                    {h.page ? ` · trang ${h.page}` : ""}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}

      {query.hasNextPage && (
        <button
          type="button"
          className="btn-outline self-center"
          onClick={() => query.fetchNextPage()}
          disabled={query.isFetchingNextPage}
        >
          {query.isFetchingNextPage ? "Đang tải…" : `Xem thêm (${total - items.length} còn lại)`}
        </button>
      )}
    </div>
  );
}

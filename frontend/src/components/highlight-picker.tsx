"use client";

import { useInfiniteQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useMemo, useState } from "react";

import {
  CATEGORIES,
  categoryLabel,
  fromDto,
  highlightsKey,
  type HighlightCategory,
  type HighlightPage,
} from "@/lib/annotations";
import { api } from "@/lib/api";
import { useDocuments } from "@/lib/documents";
import { useLang, useT } from "@/lib/i18n";
import { MSG } from "@/lib/messages";
import { MAX_NOTEBOOK_SOURCES } from "@/lib/notebooks";
import { COLOR_DOT } from "@/lib/preferences";

import { Alert, Spinner } from "./ui";

const PAGE_SIZE = 50;
const selectCls =
  "h-10 max-w-full rounded-full border border-field bg-surface pl-3.5 pr-8 text-sm text-ink outline-none focus:border-accent";

function highlightsPath(docId: string, category: string, page: number, pageSize = PAGE_SIZE) {
  const params = new URLSearchParams({ sort: "document", page: String(page), page_size: String(pageSize) });
  if (docId) params.set("document_id", docId);
  if (category) params.set("category", category);
  return `/highlights?${params}`;
}

/**
 * FR-NB-01: pick up to 100 highlights, with the same filters as the Highlights page.
 * `fixed` highlights are already in the notebook: shown checked and not selectable again.
 */
export function HighlightPicker({
  selected,
  onChange,
  initialDocId = "",
  fixed,
}: {
  selected: string[];
  onChange: (ids: string[]) => void;
  initialDocId?: string;
  fixed?: Set<string>;
}) {
  const t = useT();
  const lang = useLang();
  const { data: docs } = useDocuments("created_desc");
  const [docId, setDocId] = useState(initialDocId);
  const [category, setCategory] = useState<HighlightCategory | "">("");
  const [limitHit, setLimitHit] = useState(false);
  const [selectingAll, setSelectingAll] = useState(false);

  const docById = useMemo(() => new Map((docs ?? []).map((d) => [d.id, d])), [docs]);
  const chosen = useMemo(() => new Set(selected), [selected]);
  const taken = fixed?.size ?? 0;
  const room = MAX_NOTEBOOK_SOURCES - taken;

  const query = useInfiniteQuery({
    queryKey: [...highlightsKey, "picker", { docId, category }],
    initialPageParam: 1,
    queryFn: ({ pageParam }) => api<HighlightPage>(highlightsPath(docId, category, pageParam)),
    getNextPageParam: (last, pages) => (pages.length * PAGE_SIZE < last.total ? pages.length + 1 : undefined),
  });
  const items = query.data?.pages.flatMap((p) => p.items.map(fromDto)) ?? [];
  const total = query.data?.pages[0]?.total ?? 0;
  const filtered = Boolean(docId || category);

  function toggle(id: string) {
    setLimitHit(false);
    if (chosen.has(id)) return onChange(selected.filter((x) => x !== id));
    if (selected.length >= room) return setLimitHit(true);
    onChange([...selected, id]);
  }

  /** Select all that match: every matching highlight, up to the limit. */
  async function selectAll() {
    setLimitHit(false);
    setSelectingAll(true);
    try {
      const ids: string[] = [];
      for (let page = 1; ; page++) {
        const res = await api<HighlightPage>(highlightsPath(docId, category, page, 500));
        ids.push(...res.items.map((h) => h.id));
        if (page * 500 >= res.total) break;
      }
      const next = [...selected];
      for (const id of ids) {
        if (chosen.has(id) || fixed?.has(id)) continue;
        if (next.length >= room) {
          setLimitHit(true);
          break;
        }
        next.push(id);
      }
      onChange(next);
    } catch {
      /* the list itself shows connection problems */
    } finally {
      setSelectingAll(false);
    }
  }

  if (query.isSuccess && total === 0 && !filtered) {
    return (
      <div className="flex flex-col items-center gap-3.5 rounded-[14px] border border-dashed border-field px-6 py-14 text-center">
        <span className="font-serif text-[24px]">{MSG["MSG-34"]}</span>
        <span className="max-w-md text-[15px] text-muted">{t("picker.emptyHint")}</span>
        <Link href="/library" className="btn-primary">
          {t("highlights.openLibrary")}
        </Link>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2.5">
        <label className="min-w-0">
          <span className="sr-only">{t("highlights.document")}</span>
          <select value={docId} onChange={(e) => setDocId(e.target.value)} className={`${selectCls} w-[260px]`}>
            <option value="">{t("highlights.allDocuments")}</option>
            {(docs ?? []).map((d) => (
              <option key={d.id} value={d.id}>
                {d.title}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span className="sr-only">{t("highlights.category")}</span>
          <select value={category} onChange={(e) => setCategory(e.target.value as HighlightCategory | "")} className={selectCls}>
            <option value="">{t("highlights.allCategories")}</option>
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {categoryLabel(c, lang)}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="sticky top-[72px] z-10 -mx-1 flex flex-wrap items-center gap-2.5 bg-bg px-1 py-2">
        <span className="text-sm font-semibold text-ink" aria-live="polite">
          {t("picker.chosen", { n: selected.length + taken, max: MAX_NOTEBOOK_SOURCES })}
        </span>
        <span className="flex-1" />
        <button
          type="button"
          className="btn-ghost h-9 px-3 text-sm"
          onClick={() => void selectAll()}
          disabled={selectingAll || total === 0}
        >
          {t(selectingAll ? "picker.selecting" : "picker.selectAll")}
        </button>
        <button
          type="button"
          className="btn-ghost h-9 px-3 text-sm"
          onClick={() => {
            setLimitHit(false);
            onChange([]);
          }}
          disabled={selected.length === 0}
        >
          {t("picker.clear")}
        </button>
      </div>
      {limitHit && <Alert>{MSG["MSG-28"]}</Alert>}

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
        <p className="py-8 text-center text-[15px] text-muted">{t("picker.noMatch")}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {items.map((h) => {
            const doc = docById.get(h.docId);
            const inNotebook = fixed?.has(h.id) ?? false;
            const checked = inNotebook || chosen.has(h.id);
            return (
              <li key={h.id}>
                <label
                  className={`flex gap-3 rounded-xl border p-3.5 transition-colors ${
                    checked ? "border-accent bg-accent/5" : "border-line bg-surface hover:bg-soft/50"
                  } ${inNotebook ? "cursor-default opacity-70" : "cursor-pointer"}`}
                >
                  <input
                    type="checkbox"
                    className="mt-1 h-4 w-4 shrink-0 accent-[rgb(var(--accent))]"
                    checked={checked}
                    disabled={inNotebook}
                    onChange={() => toggle(h.id)}
                  />
                  <span className="flex min-w-0 flex-1 flex-col gap-1.5">
                    <span className="line-clamp-3 font-serif text-[16px] leading-relaxed text-ink">
                      <span className={`box-decoration-clone hl-bg-${h.color}`}>{h.text}</span>
                    </span>
                    {h.note && <span className="line-clamp-2 text-sm text-body">{t("picker.notePrefix", { note: h.note })}</span>}
                    <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-muted">
                      <span className="h-2.5 w-2.5 rounded-full" style={{ background: COLOR_DOT[h.color] }} aria-hidden />
                      {h.category && <span className="font-semibold text-ink">{categoryLabel(h.category, lang)}</span>}
                      <span className="min-w-0 truncate">
                        {doc?.title ?? t("highlights.document")}
                        {h.page ? ` · ${t("search.pageOf", { page: h.page })}` : ""}
                      </span>
                      {inNotebook && <span>{t("picker.inNotebook")}</span>}
                    </span>
                  </span>
                </label>
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
          {query.isFetchingNextPage ? t("common.loading") : t("common.loadMore", { n: total - items.length })}
        </button>
      )}
    </div>
  );
}

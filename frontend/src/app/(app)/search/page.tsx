"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";

import { Icon } from "@/components/icons";
import { Alert, Spinner } from "@/components/ui";
import { CATEGORIES, CATEGORY_LABEL, type HighlightCategory } from "@/lib/annotations";
import { api } from "@/lib/api";
import { KIND_CLASS, KIND_LABEL } from "@/lib/doc-view";
import { MSG } from "@/lib/messages";
import { COLOR_DOT, colorLabel, usePreferences } from "@/lib/preferences";
import {
  GROUP_OF,
  MIN_QUERY,
  SEARCH_TYPES,
  hitHref,
  searchPath,
  snippetParts,
  type SearchGroup,
  type SearchHit,
  type SearchResults,
  type SearchType,
} from "@/lib/search";

const TYPE_LABEL: Record<SearchType, string> = {
  document: "Tài liệu",
  highlight: "Highlight",
  note: "Ghi chú",
  summary: "Tóm tắt AI",
  notebook: "Notebook",
};
const isType = (v: string | null): v is SearchType => SEARCH_TYPES.includes(v as SearchType);
const isCategory = (v: string | null): v is HighlightCategory => CATEGORIES.includes(v as HighlightCategory);

function Snippet({ text }: { text: string }) {
  return (
    <>
      {snippetParts(text).map((p, i) =>
        p.match ? (
          <mark key={i} className="pm-mark">
            {p.text}
          </mark>
        ) : (
          <span key={i}>{p.text}</span>
        ),
      )}
    </>
  );
}

function HitRow({ hit, q }: { hit: SearchHit; q: string }) {
  const labels = usePreferences((s) => s.colorLabels);
  const source = `${hit.document_title}${hit.page_number ? ` · trang ${hit.page_number}` : ""}`;
  return (
    <li>
      <Link
        href={hitHref(hit, q)}
        className="flex gap-3.5 rounded-xl border border-line bg-surface p-4 transition-shadow hover:shadow-float"
      >
        {hit.kind === "document" && hit.file_type ? (
          <span className={`flex h-6 w-11 shrink-0 items-center justify-center rounded-[5px] text-[11px] font-bold ${KIND_CLASS[hit.file_type]}`}>
            {KIND_LABEL[hit.file_type]}
          </span>
        ) : hit.kind === "highlight" && hit.color ? (
          <span className="mt-1.5 h-3 w-3 shrink-0 rounded-full" style={{ background: COLOR_DOT[hit.color] }} />
        ) : (
          <span className="mt-0.5 shrink-0 text-muted">
            <Icon name={hit.kind === "summary" || hit.kind === "notebook" ? "spark" : "note"} size={18} />
          </span>
        )}
        <span className="flex min-w-0 flex-1 flex-col gap-1.5">
          {(hit.kind === "document" || hit.kind === "notebook") && (
            <span className="truncate font-serif text-lg font-medium text-ink">{hit.document_title}</span>
          )}
          <span className={`line-clamp-3 leading-relaxed text-body ${hit.kind === "highlight" ? "font-serif text-[16px]" : "text-sm"}`}>
            <Snippet text={hit.snippet} />
          </span>
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
            {hit.kind === "highlight" && hit.color && <span>{colorLabel(labels, hit.color)}</span>}
            {hit.kind === "note" && <span>Ghi chú của highlight</span>}
            {hit.kind === "document_note" && <span>Ghi chú tài liệu</span>}
            {hit.kind === "summary" && <span>Tóm tắt AI</span>}
            {hit.kind === "notebook" && <span>Notebook</span>}
            {hit.category && (
              <span className="rounded-full border border-line px-2 py-0.5 font-medium text-ink">{CATEGORY_LABEL[hit.category]}</span>
            )}
            {hit.kind !== "document" && hit.kind !== "notebook" && <span className="min-w-0 truncate">{source}</span>}
          </span>
        </span>
      </Link>
    </li>
  );
}

/** One result group; "Xem thêm" loads the next 10 of this type only. */
function Group({
  type,
  group,
  q,
  category,
}: {
  type: SearchType;
  group: SearchGroup;
  q: string;
  category: HighlightCategory | null;
}) {
  const [extra, setExtra] = useState<SearchHit[]>([]);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const items = [...group.items, ...extra];

  async function more() {
    setLoading(true);
    setError(null);
    try {
      const res = await api<SearchResults>(searchPath(q, { types: [type], category, page: page + 1 }));
      setExtra((e) => [...e, ...res[GROUP_OF[type]].items]);
      setPage((p) => p + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : MSG["MSG-99"]);
    } finally {
      setLoading(false);
    }
  }

  if (!group.total) return null;
  return (
    <section className="flex flex-col gap-3" aria-label={TYPE_LABEL[type]}>
      <h2 className="eyebrow">
        {TYPE_LABEL[type].toUpperCase()} · {group.total}
      </h2>
      <ul className="flex flex-col gap-2.5">
        {items.map((hit) => (
          <HitRow key={`${hit.kind}-${hit.id}`} hit={hit} q={q} />
        ))}
      </ul>
      {error && <Alert>{error}</Alert>}
      {items.length < group.total && (
        <button type="button" className="btn-outline self-start" onClick={more} disabled={loading}>
          {loading ? "Đang tải…" : `Xem thêm ${TYPE_LABEL[type].toLowerCase()} (${group.total - items.length})`}
        </button>
      )}
    </section>
  );
}

function SearchView() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const q = (params.get("q") ?? "").replace(/\s+/g, " ").trim();
  const typeParam = params.get("type");
  const type: SearchType | null = isType(typeParam) ? typeParam : null;
  const catParam = params.get("category");
  const category: HighlightCategory | null = isCategory(catParam) ? catParam : null;
  const [input, setInput] = useState(params.get("q") ?? "");

  function go(next: { q?: string; type?: SearchType | null; category?: HighlightCategory | null }) {
    const p = new URLSearchParams();
    const nq = next.q ?? input;
    const nt = next.type === undefined ? type : next.type;
    const nc = next.category === undefined ? category : next.category;
    if (nq.trim()) p.set("q", nq.trim());
    if (nt) p.set("type", nt);
    if (nc) p.set("category", nc);
    router.replace(`${pathname}?${p}`, { scroll: false });
  }

  // Typing searches shortly after the last key.
  useEffect(() => {
    if (input.replace(/\s+/g, " ").trim() === q) return;
    const t = setTimeout(() => go({ q: input }), 350);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [input]);

  const ready = q.length >= MIN_QUERY && /[\p{L}\p{N}]/u.test(q);
  // A category narrows the search to highlights and their notes.
  const types = category ? (["highlight", "note"] as SearchType[]) : SEARCH_TYPES;
  const results = useQuery({
    queryKey: ["search", q, category],
    queryFn: () => api<SearchResults>(searchPath(q, { types, category })),
    enabled: ready,
    staleTime: 30_000,
  });

  const data = results.data;
  const count = (t: SearchType) => data?.[GROUP_OF[t]].total ?? 0;
  const total = types.reduce((n, t) => n + count(t), 0);
  const shown = (type ? [type] : types).filter((t) => types.includes(t));

  return (
    <div className="mx-auto flex max-w-[880px] flex-col gap-6">
      <h1 className="font-serif text-4xl font-medium leading-[1.1] sm:text-5xl">Tìm kiếm</h1>

      <label className="flex h-14 items-center gap-3 rounded-xl border border-field bg-surface px-4 text-muted focus-within:border-accent">
        <Icon name="search" size={20} />
        <span className="sr-only">Từ khóa</span>
        <input
          autoFocus
          value={input}
          maxLength={200}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") go({ q: input });
          }}
          placeholder="Tìm trong tài liệu, highlight và ghi chú…"
          className="min-w-0 flex-1 bg-transparent text-lg text-ink outline-none"
        />
        {input && (
          <button type="button" className="btn-ghost h-10 px-3 text-[13px] text-muted" onClick={() => setInput("")}>
            Xóa
          </button>
        )}
      </label>

      <div className="flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Loại kết quả">
          <button type="button" role="tab" aria-selected={!type} className="chip h-9 px-3.5 text-[13px]" onClick={() => go({ type: null })}>
            Tất cả{data ? ` · ${total}` : ""}
          </button>
          {types.map((t) => (
            <button key={t} type="button" role="tab" aria-selected={type === t} className="chip h-9 px-3.5 text-[13px]" onClick={() => go({ type: t })}>
              {TYPE_LABEL[t]}
              {data ? ` · ${count(t)}` : ""}
            </button>
          ))}
        </div>
        <span className="flex-1" />
        <label>
          <span className="sr-only">Danh mục highlight</span>
          <select
            value={category ?? ""}
            onChange={(e) => go({ category: isCategory(e.target.value) ? e.target.value : null, type: null })}
            className="h-9 rounded-full border border-field bg-surface pl-3 pr-8 text-[13px] text-ink outline-none focus:border-accent"
          >
            <option value="">Mọi danh mục</option>
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {CATEGORY_LABEL[c]}
              </option>
            ))}
          </select>
        </label>
      </div>

      {!ready ? (
        <p className="rounded-xl bg-soft px-4 py-3.5 text-sm text-muted">
          Nhập ít nhất 2 ký tự để tìm. Không cần gõ dấu: “tong quat” cũng tìm thấy “tổng quát”.
        </p>
      ) : results.isPending ? (
        <Spinner label="Đang tìm…" />
      ) : results.isError ? (
        <div className="flex flex-col items-start gap-3">
          <Alert>{results.error instanceof Error ? results.error.message : MSG["MSG-99"]}</Alert>
          <button type="button" className="btn-outline" onClick={() => results.refetch()}>
            Thử lại
          </button>
        </div>
      ) : shown.every((t) => !count(t)) ? (
        <div className="flex flex-col items-center gap-3.5 rounded-[14px] border border-dashed border-field px-6 py-14 text-center">
          <span className="max-w-md text-[15px] text-muted">{MSG["MSG-36"]}</span>
          {(category || type) && (
            <button type="button" className="btn-outline" onClick={() => go({ type: null, category: null })}>
              Bỏ bộ lọc
            </button>
          )}
        </div>
      ) : (
        shown.map((t) => (
          <Group key={`${t}-${q}-${category}`} type={t} group={data![GROUP_OF[t]]} q={q} category={category} />
        ))
      )}
    </div>
  );
}

/** FR-SRCH-01: keyword search over documents, highlights, notes and AI summaries, grouped by type. */
export default function SearchPage() {
  return (
    <Suspense fallback={<Spinner />}>
      <SearchView />
    </Suspense>
  );
}

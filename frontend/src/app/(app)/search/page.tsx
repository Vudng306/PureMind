"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";

import { Icon } from "@/components/icons";
import { Alert, Spinner } from "@/components/ui";
import { CATEGORIES, categoryLabel, type HighlightCategory } from "@/lib/annotations";
import { api } from "@/lib/api";
import { KIND_CLASS, KIND_LABEL } from "@/lib/doc-view";
import { useLang, useMsg, useT, type Key, type T } from "@/lib/i18n";
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

const TYPE_LABEL: Record<SearchType, Key> = {
  document: "search.typeDocument",
  highlight: "search.typeHighlight",
  note: "search.typeNote",
  summary: "search.typeSummary",
  notebook: "search.typeNotebook",
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
  const t = useT();
  const lang = useLang();
  const labels = usePreferences((s) => s.colorLabels);
  const page = hit.page_number ? ` · ${t("search.pageOf", { page: hit.page_number })}` : "";
  const source = `${hit.document_title}${page}`;
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
            {hit.kind === "highlight" && hit.color && <span>{colorLabel(labels, hit.color, lang)}</span>}
            {hit.kind === "note" && <span>{t("search.highlightNote")}</span>}
            {hit.kind === "document_note" && <span>{t("search.documentNote")}</span>}
            {hit.kind === "summary" && <span>{t("search.typeSummary")}</span>}
            {hit.kind === "notebook" && <span>Notebook</span>}
            {hit.category && (
              <span className="rounded-full border border-line px-2 py-0.5 font-medium text-ink">{categoryLabel(hit.category, lang)}</span>
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
  const t = useT();
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
    <section className="flex flex-col gap-3" aria-label={t(TYPE_LABEL[type])}>
      <h2 className="eyebrow">
        {t(TYPE_LABEL[type]).toUpperCase()} · {group.total}
      </h2>
      <ul className="flex flex-col gap-2.5">
        {items.map((hit) => (
          <HitRow key={`${hit.kind}-${hit.id}`} hit={hit} q={q} />
        ))}
      </ul>
      {error && <Alert>{error}</Alert>}
      {items.length < group.total && (
        <button type="button" className="btn-outline self-start" onClick={more} disabled={loading}>
          {loading
            ? t("common.loading")
            : t("search.loadMoreOf", { type: t(TYPE_LABEL[type]).toLowerCase(), n: group.total - items.length })}
        </button>
      )}
    </section>
  );
}

function SearchView() {
  const t: T = useT();
  const msg = useMsg();
  const lang = useLang();
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
    const timer = setTimeout(() => go({ q: input }), 350);
    return () => clearTimeout(timer);
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
  const count = (kind: SearchType) => data?.[GROUP_OF[kind]].total ?? 0;
  const total = types.reduce((n, kind) => n + count(kind), 0);
  const shown = (type ? [type] : types).filter((kind) => types.includes(kind));

  return (
    <div className="mx-auto flex max-w-[880px] flex-col gap-6">
      <h1 className="font-serif text-4xl font-medium leading-[1.1] sm:text-5xl">{t("search.title")}</h1>

      <label className="flex h-14 items-center gap-3 rounded-xl border border-field bg-surface px-4 text-muted focus-within:border-accent">
        <Icon name="search" size={20} />
        <span className="sr-only">{t("search.keyword")}</span>
        <input
          autoFocus
          value={input}
          maxLength={200}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") go({ q: input });
          }}
          placeholder={t("search.inputPlaceholder")}
          className="min-w-0 flex-1 bg-transparent text-lg text-ink outline-none"
        />
        {input && (
          <button type="button" className="btn-ghost h-10 px-3 text-[13px] text-muted" onClick={() => setInput("")}>
            {t("search.clear")}
          </button>
        )}
      </label>

      <div className="flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap gap-1.5" role="tablist" aria-label={t("search.resultTypes")}>
          <button type="button" role="tab" aria-selected={!type} className="chip h-9 px-3.5 text-[13px]" onClick={() => go({ type: null })}>
            {t("common.all")}
            {data ? ` · ${total}` : ""}
          </button>
          {types.map((kind) => (
            <button
              key={kind}
              type="button"
              role="tab"
              aria-selected={type === kind}
              className="chip h-9 px-3.5 text-[13px]"
              onClick={() => go({ type: kind })}
            >
              {t(TYPE_LABEL[kind])}
              {data ? ` · ${count(kind)}` : ""}
            </button>
          ))}
        </div>
        <span className="flex-1" />
        <label>
          <span className="sr-only">{t("search.highlightCategory")}</span>
          <select
            value={category ?? ""}
            onChange={(e) => go({ category: isCategory(e.target.value) ? e.target.value : null, type: null })}
            className="h-9 rounded-full border border-field bg-surface pl-3 pr-8 text-[13px] text-ink outline-none focus:border-accent"
          >
            <option value="">{t("highlights.allCategories")}</option>
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {categoryLabel(c, lang)}
              </option>
            ))}
          </select>
        </label>
      </div>

      {!ready ? (
        <p className="rounded-xl bg-soft px-4 py-3.5 text-sm text-muted">
          {t("search.hint")}
        </p>
      ) : results.isPending ? (
        <Spinner label={t("search.searching")} />
      ) : results.isError ? (
        <div className="flex flex-col items-start gap-3">
          <Alert>{results.error instanceof Error ? results.error.message : MSG["MSG-99"]}</Alert>
          <button type="button" className="btn-outline" onClick={() => results.refetch()}>
            {t("common.retry")}
          </button>
        </div>
      ) : shown.every((kind) => !count(kind)) ? (
        <div className="flex flex-col items-center gap-3.5 rounded-[14px] border border-dashed border-field px-6 py-14 text-center">
          <span className="max-w-md text-[15px] text-muted">{msg("MSG-36")}</span>
          {(category || type) && (
            <button type="button" className="btn-outline" onClick={() => go({ type: null, category: null })}>
              {t("search.dropFilters")}
            </button>
          )}
        </div>
      ) : (
        shown.map((kind) => (
          <Group key={`${kind}-${q}-${category}`} type={kind} group={data![GROUP_OF[kind]]} q={q} category={category} />
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

"use client";

import { useEffect, useState } from "react";

import { Pager, SELECT_CLS, TopicPicker, TopicTags } from "@/components/admin-parts";
import { Icon } from "@/components/icons";
import { Alert, ConfirmDialog, Spinner } from "@/components/ui";
import {
  useAddFromLink,
  useAdminArticles,
  useArticleAction,
  useCrawl,
  useQuickReadReports,
  type AdminArticle,
  type ArticleQuery,
  type ArticleSort,
  type ArticleStatus,
  type LinkResult,
} from "@/lib/admin-content";
import { formatDate } from "@/lib/documents";
import { TOPICS, type Topic } from "@/lib/feed";
import { useLang, useT, type Key } from "@/lib/i18n";

const STATUSES: [ArticleStatus, Key][] = [
  ["all", "articles.statusAll"],
  ["visible", "articles.statusVisible"],
  ["hidden", "articles.statusHidden"],
];

const SORTS: [ArticleSort, Key][] = [
  ["newest", "articles.sortNewest"],
  ["oldest", "articles.sortOldest"],
  ["collected", "articles.sortCollected"],
  ["title", "articles.sortTitle"],
];

const CUTOFF = "2023-01-01";

/** The feed's articles: find them, hide or delete one, or add one from a link. */
export default function AdminArticlesPage() {
  const t = useT();
  const lang = useLang();
  const [input, setInput] = useState("");
  const [query, setQuery] = useState<ArticleQuery>({
    q: "",
    source: "",
    topic: "",
    kind: "",
    year: "",
    language: "",
    status: "all",
    sort: "newest",
    page: 1,
  });
  const [confirm, setConfirm] = useState<AdminArticle | null>(null);
  const action = useArticleAction();
  const crawl = useCrawl();
  const names = Object.fromEntries((crawl.data?.sources ?? []).map((s) => [s.id, s.name]));

  // Search once typing pauses, not on every key.
  useEffect(() => {
    const id = setTimeout(() => setQuery((q) => (q.q === input ? q : { ...q, q: input, page: 1 })), 300);
    return () => clearTimeout(id);
  }, [input]);

  const { data, error, isPending, isFetching } = useAdminArticles(query);
  const set = (change: Partial<ArticleQuery>) => setQuery((q) => ({ ...q, ...change, page: change.page ?? 1 }));

  const th = "px-4 py-3 text-left text-xs font-semibold uppercase tracking-[0.06em] text-muted";
  const td = "px-4 py-3 align-top";

  return (
    <section className="flex flex-col gap-6">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 className="font-display text-[28px] font-semibold tracking-[-0.01em]">{t("admin.tabArticles")}</h2>
        {data && <span className="text-sm text-muted">{t("admin.pageInfo", { page: data.page, pages: Math.max(1, Math.ceil(data.total / data.page_size)), total: data.total })}</span>}
      </div>

      <AddFromLink />
      <QuickReports />

      <div className="flex flex-wrap items-center gap-2" role="group" aria-label={t("articles.filters")}>
        <label className="flex h-10 w-full items-center gap-2 rounded-full border border-field bg-surface px-3 text-muted focus-within:border-focus sm:w-[300px]">
          <Icon name="search" size={16} />
          <span className="sr-only">{t("articles.search")}</span>
          <input
            type="search"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={t("articles.searchPlaceholder")}
            className="min-w-0 flex-1 bg-transparent text-sm text-ink outline-none"
          />
        </label>
        <Select label={t("articles.colSource")} value={query.source} onChange={(v) => set({ source: v })}>
          <option value="">{t("articles.allSources")}</option>
          {data?.sources.map((f) => (
            <option key={f.value} value={f.value}>
              {names[f.value] ?? f.value} · {f.count}
            </option>
          ))}
        </Select>
        <Select label={t("articles.colTopics")} value={query.topic} onChange={(v) => set({ topic: v })}>
          <option value="">{t("articles.allTopics")}</option>
          {TOPICS.map((topic) => (
            <option key={topic} value={topic}>
              {t(`feed.topic.${topic}` as Key)}
            </option>
          ))}
        </Select>
        <Select label={t("articles.colKind")} value={query.kind} onChange={(v) => set({ kind: v })}>
          <option value="">{t("articles.allKinds")}</option>
          {data?.kinds.map((f) => (
            <option key={f.value} value={f.value}>
              {t(`feed.kind.${f.value}` as Key)} · {f.count}
            </option>
          ))}
        </Select>
        <Select label={t("articles.colPublished")} value={query.year} onChange={(v) => set({ year: v })}>
          <option value="">{t("articles.allYears")}</option>
          {data?.years.map((f) => (
            <option key={f.value} value={f.value}>
              {f.value} · {f.count}
            </option>
          ))}
        </Select>
        <Select label={t("articles.allLanguages")} value={query.language} onChange={(v) => set({ language: v })}>
          <option value="">{t("articles.allLanguages")}</option>
          {data?.languages.map((f) => (
            <option key={f.value} value={f.value}>
              {f.value.toUpperCase()} · {f.count}
            </option>
          ))}
        </Select>
        <Select label={t("articles.colStatus")} value={query.status} onChange={(v) => set({ status: v as ArticleStatus })}>
          {STATUSES.map(([value, label]) => (
            <option key={value} value={value}>
              {t(label)}
            </option>
          ))}
        </Select>
        <Select label={t("admin.sort")} value={query.sort} onChange={(v) => set({ sort: v as ArticleSort })}>
          {SORTS.map(([value, label]) => (
            <option key={value} value={value}>
              {t(label)}
            </option>
          ))}
        </Select>
      </div>

      {action.error && <Alert>{action.error.message}</Alert>}
      {error ? (
        <Alert>{error.message}</Alert>
      ) : isPending ? (
        <Spinner />
      ) : (
        <>
          <div className={`card overflow-x-auto transition-opacity ${isFetching ? "opacity-60" : ""}`}>
            <table className="w-full min-w-[900px] border-collapse text-sm">
              <thead className="border-b border-line">
                <tr>
                  <th className={th}>{t("articles.colTitle")}</th>
                  <th className={th}>{t("articles.colSource")}</th>
                  <th className={th}>{t("articles.colTopics")}</th>
                  <th className={th}>{t("articles.colPublished")}</th>
                  <th className={th}>{t("articles.colStatus")}</th>
                  <th className={`${th} text-right`}>{t("admin.actions")}</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((a) => (
                  <tr key={a.id} className={`border-b border-line last:border-0 ${a.hidden_at ? "bg-soft/60" : ""}`}>
                    <td className={`${td} max-w-[380px]`}>
                      <a href={a.url} target="_blank" rel="noreferrer" className={`font-semibold leading-snug underline-offset-2 hover:underline ${a.hidden_at ? "text-muted" : "text-ink"}`}>
                        {a.title}
                      </a>
                      <span className="mt-1 block text-xs text-muted">
                        {t(`feed.kind.${a.kind}` as Key)} · {a.language.toUpperCase()} · {a.license} · {t("articles.words", { n: a.word_count.toLocaleString() })}
                      </span>
                      {a.tags.length > 0 && <span className="mt-1 block text-xs text-muted">{a.tags.join(", ")}</span>}
                    </td>
                    <td className={`${td} whitespace-nowrap text-body`}>{a.source_name}</td>
                    <td className={td}>
                      <TopicTags topics={a.topics} />
                    </td>
                    <td className={`${td} whitespace-nowrap tabular-nums text-body`}>
                      {a.published_at ? formatDate(a.published_at, lang) : t("articles.noDate")}
                    </td>
                    <td className={td}>
                      <span className="flex flex-wrap gap-1">
                        <Badge tone={a.hidden_at ? "hidden" : "visible"}>{t(a.hidden_at ? "articles.badgeHidden" : "articles.badgeVisible")}</Badge>
                        {a.is_guide && <Badge tone="info">{t("articles.badgeGuide")}</Badge>}
                        {a.has_short && <Badge tone="info">{t("articles.badgeShort")}</Badge>}
                      </span>
                    </td>
                    <td className={`${td} text-right`}>
                      <span className="inline-flex gap-1.5">
                        <button
                          type="button"
                          className="btn-outline h-9 px-3 text-[13px]"
                          disabled={action.isPending}
                          onClick={() => action.mutate({ id: a.id, action: a.hidden_at ? "show" : "hide" })}
                        >
                          {t(a.hidden_at ? "articles.show" : "articles.hide")}
                        </button>
                        <button type="button" className="btn-ghost h-9 px-3 text-[13px] text-danger" disabled={action.isPending} onClick={() => setConfirm(a)}>
                          {t("articles.delete")}
                        </button>
                      </span>
                    </td>
                  </tr>
                ))}
                {data.items.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-4 py-10 text-center text-muted">
                      {t("articles.noArticles")}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <Pager data={data} onPage={(page) => set({ page })} />
        </>
      )}

      <ConfirmDialog
        open={confirm !== null}
        title={t("articles.delete")}
        confirmLabel={t("articles.delete")}
        cancelLabel={t("common.cancel")}
        busy={action.isPending}
        onConfirm={() => confirm && action.mutate({ id: confirm.id, action: "delete" }, { onSettled: () => setConfirm(null) })}
        onCancel={() => setConfirm(null)}
      >
        {confirm && t("articles.deleteConfirm", { title: confirm.title })}
      </ConfirmDialog>
    </section>
  );
}

function Select({ label, value, onChange, children }: { label: string; value: string; onChange: (v: string) => void; children: React.ReactNode }) {
  return (
    <label>
      <span className="sr-only">{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)} className={SELECT_CLS}>
        {children}
      </select>
    </label>
  );
}

const BADGE = {
  visible: "bg-success-soft text-success",
  hidden: "bg-ink text-bg",
  info: "bg-accent-soft text-accent-text",
} as const;

function Badge({ tone, children }: { tone: keyof typeof BADGE; children: React.ReactNode }) {
  return <span className={`inline-flex h-6 items-center whitespace-nowrap rounded-full px-2.5 text-xs font-semibold ${BADGE[tone]}`}>{children}</span>;
}

/** Paste a link to one article on a supported source; it is read and checked like a crawl's. */
/** The catalog's Quick Reads that readers say are wrong, to check against the original; nothing while there are none. */
function QuickReports() {
  const t = useT();
  const lang = useLang();
  const { data } = useQuickReadReports();
  if (!data?.length) return null;
  return (
    <div className="card flex flex-col gap-3 p-5">
      <h3 className="font-display text-lg font-semibold">{t("articles.quickReports")}</h3>
      <ul className="flex flex-col divide-y divide-line">
        {data.map((r) => (
          <li key={r.article_id} className="flex flex-col gap-1 py-2.5 first:pt-0 last:pb-0">
            <a href={r.url} target="_blank" rel="noreferrer" className="font-medium underline-offset-2 hover:underline">{r.quick_title || r.title}</a>
            <span className="text-sm text-muted">
              {t("articles.quickReportCounts", { wrong: r.wrong, missing: r.missing, other: r.other })} · {formatDate(r.last_at, lang)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function AddFromLink() {
  const t = useT();
  const [url, setUrl] = useState("");
  const [topics, setTopics] = useState<Topic[]>([]);
  const [result, setResult] = useState<LinkResult | null>(null);
  const add = useAddFromLink();
  const date = formatDate(CUTOFF);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setResult(null);
    add.mutate(
      { url: url.trim(), topics },
      {
        onSuccess: (r) => {
          setResult(r);
          if (r.status === "added" || r.status === "updated") setUrl("");
        },
      },
    );
  }

  const good = result && (result.status === "added" || result.status === "updated");

  return (
    <form onSubmit={submit} className="card flex flex-col gap-4 p-5">
      <div className="flex flex-col gap-1">
        <h3 className="text-[15px] font-semibold text-ink">{t("link.title")}</h3>
        <p className="text-[13px] leading-relaxed text-muted">{t("link.lead", { date })}</p>
      </div>
      <div className="flex flex-wrap gap-2">
        <label className="flex h-11 min-w-0 flex-1 basis-80 items-center gap-2 rounded-full border border-field bg-surface px-4 focus-within:border-focus">
          <Icon name="link" size={16} />
          <span className="sr-only">{t("link.url")}</span>
          <input
            type="url"
            required
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://theconversation.com/…"
            className="min-w-0 flex-1 bg-transparent text-sm text-ink outline-none"
          />
        </label>
        <button type="submit" className="btn-primary h-11 px-5" disabled={add.isPending || !url.trim()}>
          {t(add.isPending ? "link.adding" : "link.submit")}
        </button>
      </div>
      <div className="flex flex-col gap-2">
        <span className="text-[13px] font-medium text-body">{t("link.topics")}</span>
        <TopicPicker value={topics} onChange={setTopics} label={t("link.topics")} />
      </div>
      {add.error && <Alert>{add.error.message}</Alert>}
      {result && (
        <p role="status" className={`rounded-2xl px-4 py-3 text-sm ${good ? "bg-success-soft text-success" : "bg-soft text-body"}`}>
          {t(`link.${result.status}` as Key, { title: result.title ?? "", date })}
        </p>
      )}
    </form>
  );
}

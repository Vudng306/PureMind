"use client";

import { useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { useAuth } from "@/components/auth-provider";
import { Icon } from "@/components/icons";
import { LanguageToggle } from "@/components/language-toggle";
import { SharedLibrary } from "@/components/shared-library";
import { Alert, Spinner } from "@/components/ui";
import { useImportDoi } from "@/lib/documents";
import { useT, type Key } from "@/lib/i18n";
import { MSG } from "@/lib/messages";
import {
  CATEGORIES,
  arxivUrl,
  authorLine,
  filterPapers,
  papersKey,
  usePaperCollections,
  usePaperSearch,
  type Category,
  type CollectionId,
  type Paper,
} from "@/lib/papers";
import { useUi } from "@/lib/ui-store";

type Tab = "papers" | "shared";

/** Public: a visitor browses the picks and the open articles; adding a paper or searching arXiv needs an account. */
export default function ExplorePage() {
  const t = useT();
  const { session } = useAuth();
  const [tab, setTab] = useState<Tab>("papers");

  return (
    <div className="app-backdrop min-h-screen">
      <header className="glass sticky top-0 z-20 border-b">
        <div className="flex h-[72px] items-center gap-3 px-4 sm:gap-7 sm:px-10">
          <Link href={session ? "/library" : "/"} className="font-serif font-semibold text-[22px] sm:text-[26px]">
            PureMind
          </Link>
          <span className="flex-1" />
          <LanguageToggle />
          {session ? (
            <Link href="/library" className="btn-outline h-11 px-4">
              {t("explore.myLibrary")}
            </Link>
          ) : (
            <Link href="/login" className="btn-primary h-11 px-4">
              {t("explore.signIn")}
            </Link>
          )}
        </div>
      </header>

      <main className="mx-auto flex max-w-[1200px] flex-col gap-7 px-4 pb-[72px] pt-8 sm:px-10 sm:pt-10">
        <div className="flex flex-col gap-3">
          <h1 className="font-serif text-4xl font-medium leading-[1.1] sm:text-5xl">{t("explore.title")}</h1>
          <p className="max-w-3xl text-base leading-relaxed text-muted">{t("explore.lead")}</p>
        </div>

        <div role="tablist" className="flex flex-wrap gap-2 border-b border-line pb-4">
          {(
            [
              ["papers", "quote", "explore.tabPapers"],
              ["shared", "file", "explore.tabShared"],
            ] as const
          ).map(([value, icon, label]) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={tab === value}
              onClick={() => setTab(value)}
              className="chip h-[42px]"
            >
              <Icon name={icon} size={16} />
              {t(label)}
            </button>
          ))}
        </div>

        {tab === "papers" ? <LandmarkPapers signedIn={Boolean(session)} /> : <SharedLibrary />}
      </main>
    </div>
  );
}

function LandmarkPapers({ signedIn }: { signedIn: boolean }) {
  const t = useT();
  const [collection, setCollection] = useState<CollectionId | "all">("all");
  const [filter, setFilter] = useState("");
  const [category, setCategory] = useState<Category | "">("");
  // The words sent to arXiv: set on Enter, so typing only filters the picks already on screen.
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const collections = usePaperCollections(signedIn);
  const search = usePaperSearch(signedIn ? query : "", category, page);
  const searching = signedIn && query.trim().length > 0;

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!signedIn || !filter.trim()) return;
    setQuery(filter.trim());
    setPage(0);
  }

  function backToPicks() {
    setQuery("");
    setPage(0);
  }

  const groups = collections.data ?? [];
  const picks = groups.filter((g) => collection === "all" || g.id === collection).flatMap((g) => g.papers);
  const shown = filterPapers(picks, filter);

  return (
    <div className="flex flex-col gap-6">
      <form onSubmit={submit} className="flex flex-wrap items-center gap-2.5">
        <label className="flex h-12 min-w-0 flex-1 basis-72 items-center gap-2 rounded-full border border-field bg-surface px-4 text-muted focus-within:border-accent">
          <Icon name="search" size={18} />
          <span className="sr-only">{t("papers.searchLabel")}</span>
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder={t("papers.searchPlaceholder")}
            maxLength={200}
            className="min-w-0 flex-1 bg-transparent text-[15px] text-ink outline-none"
          />
        </label>
        <label>
          <span className="sr-only">{t("papers.fieldLabel")}</span>
          <select
            value={category}
            onChange={(e) => {
              setCategory(e.target.value as Category | "");
              setPage(0);
            }}
            disabled={!signedIn}
            className="h-12 rounded-full border border-field bg-surface pl-4 pr-8 text-sm text-ink outline-none focus:border-accent disabled:opacity-50"
          >
            <option value="">{t("papers.anyField")}</option>
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {t(`papers.cat.${c}` as Key)}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" className="btn-dark h-12 px-5" disabled={!signedIn || !filter.trim() || search.isFetching}>
          {t(search.isFetching ? "papers.searching" : "papers.searchArxiv")}
        </button>
      </form>
      {!signedIn && (
        <p className="-mt-3 text-sm text-muted">
          <Link href="/login" className="text-accent underline underline-offset-2">
            {t("explore.signIn")}
          </Link>{" "}
          · {t("papers.signInToSearch")}
        </p>
      )}

      {searching ? (
        <section className="flex flex-col gap-5">
          <div className="flex flex-wrap items-center gap-3">
            <button type="button" className="btn-ghost px-3 text-sm text-accent" onClick={backToPicks}>
              {t("papers.backToFeatured")}
            </button>
            {search.data && (
              <span role="status" className="text-sm text-muted">
                {t("papers.resultsFor", { total: search.data.total.toLocaleString(), q: query })}
              </span>
            )}
          </div>
          {search.isLoading ? (
            <Spinner />
          ) : search.isError ? (
            <Alert>{search.error instanceof Error ? search.error.message : MSG["MSG-99"]}</Alert>
          ) : search.data?.papers.length ? (
            <>
              <PaperGrid papers={search.data.papers} signedIn={signedIn} />
              <div className="flex justify-center gap-3">
                {page > 0 && (
                  <button type="button" className="btn-outline h-11 px-5" onClick={() => setPage(page - 1)}>
                    ←
                  </button>
                )}
                {search.data.has_more && (
                  <button type="button" className="btn-outline h-11 px-5" onClick={() => setPage(page + 1)}>
                    {t("papers.more")} →
                  </button>
                )}
              </div>
            </>
          ) : (
            <p className="text-muted">{t("papers.noResults")}</p>
          )}
        </section>
      ) : (
        <section className="flex flex-col gap-5">
          <div className="flex flex-wrap gap-2">
            <button type="button" className="chip" aria-pressed={collection === "all"} onClick={() => setCollection("all")}>
              {t("papers.all")}
            </button>
            {groups.map((g) => (
              <button key={g.id} type="button" className="chip" aria-pressed={collection === g.id} onClick={() => setCollection(g.id)}>
                {t(`papers.col.${g.id}` as Key)} · {g.papers.length}
              </button>
            ))}
          </div>
          {collections.isLoading ? (
            <Spinner />
          ) : collections.isError ? (
            <div className="flex flex-col items-start gap-3">
              <Alert>{t("papers.loadError")}</Alert>
              <button type="button" className="btn-outline" onClick={() => collections.refetch()}>
                {t("common.retry")}
              </button>
            </div>
          ) : (
            <>
              <p role="status" className="text-sm text-muted">
                {filter.trim()
                  ? t("papers.filteredCount", { n: shown.length, total: picks.length })
                  : t("papers.featuredCount", { n: picks.length })}
              </p>
              {shown.length ? <PaperGrid papers={shown} signedIn={signedIn} /> : <p className="text-muted">{t("papers.noMatch")}</p>}
            </>
          )}
        </section>
      )}
    </div>
  );
}

function PaperGrid({ papers, signedIn }: { papers: Paper[]; signedIn: boolean }) {
  return (
    <div className="grid gap-5 md:grid-cols-2 lg:grid-cols-3">
      {papers.map((p) => (
        <PaperCard key={p.arxiv_id} paper={p} signedIn={signedIn} />
      ))}
    </div>
  );
}

function PaperCard({ paper, signedIn }: { paper: Paper; signedIn: boolean }) {
  const t = useT();
  const router = useRouter();
  const qc = useQueryClient();
  const { showToast } = useUi();
  const importDoi = useImportDoi();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Known as soon as it is added, before the lists are fetched again.
  const [added, setAdded] = useState<string | null>(null);
  const docId = paper.document_id ?? added;
  const category = (CATEGORIES as readonly string[]).includes(paper.category) ? t(`papers.cat.${paper.category}` as Key) : paper.category;

  async function add() {
    if (!signedIn) return router.push("/login");
    setError(null);
    try {
      const doc = await importDoi.mutateAsync(paper.doi);
      setAdded(doc.id);
      const extracting = doc.extraction_status === "pending" || doc.extraction_status === "processing";
      showToast(t(extracting ? "papers.addedExtracting" : "papers.added", { title: paper.title }));
      void qc.invalidateQueries({ queryKey: papersKey });
    } catch (err) {
      setError(err instanceof Error ? err.message : MSG["MSG-99"]);
    }
  }

  return (
    <article className="flex flex-col gap-3 rounded-[14px] border border-line bg-surface p-6">
      <span className="eyebrow">
        {category}
        {paper.year ? ` · ${paper.year}` : ""}
      </span>
      <h2 className="font-serif text-[22px] font-medium leading-snug">{paper.title}</h2>
      <p className="text-sm text-muted">{authorLine(paper)}</p>
      <p className={`text-sm leading-relaxed ${open ? "" : "line-clamp-4"}`}>{paper.abstract}</p>
      <button type="button" className="self-start text-sm text-accent underline-offset-2 hover:underline" onClick={() => setOpen(!open)} aria-expanded={open}>
        {t(open ? "papers.hideAbstract" : "papers.showAbstract")}
      </button>
      {error && <Alert>{error}</Alert>}
      <div className="mt-auto flex flex-wrap items-center gap-2 pt-2">
        {docId ? (
          <Link href={`/reader/${docId}`} className="btn-dark h-11 px-4">
            {t("papers.read")}
            <Icon name="arrow" size={16} />
          </Link>
        ) : (
          <button type="button" className="btn-primary h-11 px-4" onClick={() => void add()} disabled={importDoi.isPending}>
            <Icon name="plus" size={16} />
            {t(importDoi.isPending ? "papers.adding" : "papers.add")}
          </button>
        )}
        <a href={arxivUrl(paper)} target="_blank" rel="noreferrer" className="btn-ghost h-11 px-3 text-sm" title={t("papers.openArxiv")}>
          arXiv ↗
        </a>
      </div>
    </article>
  );
}

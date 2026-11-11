"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";

import { ArticleReading } from "@/components/article-reading";
import { Icon } from "@/components/icons";
import { API_URL, api } from "@/lib/api";
import { GRADES, TOPICS, featuredOf, orderTopics, readNext, type Article, type Catalog, type Grade, type Pick } from "@/lib/catalog";
import { documentsKey } from "@/lib/documents";
import { readingMinutes } from "@/lib/feed";
import { useLang, useT, type Key } from "@/lib/i18n";
import { MSG } from "@/lib/messages";
import { toneAt } from "@/lib/tone";
import type { DocumentDetail } from "@/lib/types";
import { useUi } from "@/lib/ui-store";

/** Where the cover's two discs sit: the same for the same article, different from one article to the next. */
function coverStyle(id: string): React.CSSProperties {
  let hash = 0;
  for (const ch of id) hash = (hash * 33 + ch.codePointAt(0)!) | 0;
  const at = (shift: number, from: number, span: number) => `${from + (Math.abs(hash >> shift) % span)}%`;
  return {
    "--ax": at(0, 62, 38),
    "--ay": at(5, -10, 50),
    "--bx": at(10, -10, 40),
    "--by": at(15, 60, 70),
  } as React.CSSProperties;
}

const SECTION_LABEL = "(?:abstract|background|introduction|objectives?|aims?|purpose|context|importance)";
const LEADING_LABEL = new RegExp(`^${SECTION_LABEL}(?:\\s*/\\s*${SECTION_LABEL})*\\b\\s*[:.]?\\s*`, "i");

/** A card's text without the abstract's section label ("## INTRODUCTION Characterized by…", "Background/Objectives : To…"). */
function summaryOf(text: string): string {
  return text.replace(/^\s*(?:#+\s*)?/, "").replace(LEADING_LABEL, "");
}

/** The front page asks only for the hand-chosen entries: three lead, the rest are worth reading next. */
const FRONT_LIMIT = 24;
const PAGE_SIZE = 24;

/** What one card can do, the same on all of them. */
type CardActions = {
  label: (name: string) => string;
  toneFor: (name: string) => string;
  opening: string | null;
  saved: ReadonlySet<string>;
  onOpen: (article: Article) => void;
  /** Absent for a visitor, who has no library to save to. */
  onSave?: (article: Article) => void;
};

/** What an article is and how long it takes, above its title: for a handbook entry, its number in the book and
 * the grade of its evidence. */
function ArticleMeta({ article: a }: { article: Article }) {
  const t = useT();
  const minutes = readingMinutes(a.word_count ?? 0);
  return (
    <span className="text-xs font-semibold tracking-wide">
      {a.ref ? t("catalog.entry", { ref: a.ref }) : t(`feed.kind.${a.kind}` as Key)}
      {a.grade ? ` · ${t("catalog.gradeShort", { grade: a.grade })}` : ""}
      {a.quick
        ? ` · ${t("catalog.quickMeta", { n: minutes })}`
        : a.word_count ? ` · ${t("common.minutesRead", { n: minutes })}` : ""}
    </span>
  );
}

/** A card's foot: where the article comes from, and saving it. Outside the card's main button, as a button
 * cannot hold another. */
function CardFoot({ article: a, actions }: { article: Article; actions: CardActions }) {
  const t = useT();
  const saved = actions.saved.has(a.id);
  return (
    <span className="flex min-h-[52px] items-center justify-between gap-3 border-t border-line px-5 py-1.5 text-xs sm:px-6">
      <span className={`min-w-0 truncate ${actions.opening === a.id ? "font-semibold text-accent-text" : "text-muted"}`}>
        {actions.opening === a.id ? t("catalog.opening") : `${a.source} · ${a.license} · ${a.language.toUpperCase()}`}
      </span>
      {actions.onSave && (
        <button
          type="button"
          disabled={saved || actions.opening !== null}
          onClick={() => actions.onSave?.(a)}
          className="btn-ghost -mr-2 h-10 shrink-0 gap-1.5 px-3 text-[13px] disabled:cursor-default"
        >
          <Icon name={saved ? "check" : "bookmark"} size={15} />
          {saved ? t("feed.savedShort") : t("feed.save")}
        </button>
      )}
    </span>
  );
}

/** One article in a grid: a cover in its topic's colour, then what it is, its title and what it says. Under
 * its topic's own heading it leaves out the topic. */
function ArticleTile({ article: a, showTopic, actions }: { article: Article; showTopic: boolean; actions: CardActions }) {
  const lang = useLang();
  const title = lang === "vi" ? a.quick?.title ?? a.vi?.title : undefined;
  const line = lang === "vi" ? a.quick?.problem ?? a.vi?.description : undefined;
  return (
    <div className={`card group flex h-full flex-col overflow-hidden transition duration-200 hover:-translate-y-0.5 hover:shadow-float ${actions.toneFor(a.topic)}`}>
      <button onClick={() => actions.onOpen(a)} disabled={actions.opening !== null} aria-busy={actions.opening === a.id} className="flex w-full flex-1 flex-col text-left disabled:cursor-wait">
        <span className={`cover-art flex w-full items-end p-4 ${showTopic ? "h-24" : "h-12"}`} style={coverStyle(a.id)}>
          {showTopic && (
            <span className="inline-flex max-w-full items-center gap-2 rounded-full bg-surface/85 px-3 py-1 text-xs font-semibold text-tone-fg shadow-sm backdrop-blur-sm">
              <span aria-hidden className="h-2 w-2 shrink-0 rounded-full bg-tone" />
              <span className="truncate">{actions.label(a.topic)}</span>
            </span>
          )}
        </span>
        <span className="flex flex-1 flex-col gap-2.5 p-5 sm:p-6">
          <span className="text-tone-fg"><ArticleMeta article={a} /></span>
          <span className="line-clamp-3 font-display text-[21px] font-semibold leading-snug tracking-[-0.005em] group-hover:underline group-hover:decoration-tone group-hover:underline-offset-4">{title ?? a.title}</span>
          <span className="line-clamp-3 text-[14.5px] leading-relaxed text-muted">{line ?? summaryOf(a.description)}</span>
        </span>
      </button>
      <CardFoot article={a} actions={actions} />
    </div>
  );
}

/** A featured article. In Vietnamese it leads with a Vietnamese headline, written by hand or else its Quick
 * Read's, and keeps the article's own title beneath it, so a reader knows what they will open. The first is the
 * page's largest. */
function FeaturedStory({ pick, lead, actions }: { pick: Pick; lead: boolean; actions: CardActions }) {
  const t = useT();
  const lang = useLang();
  const a = pick.article;
  const title = lang === "vi" ? pick.title ?? a.quick?.title ?? a.vi?.title : undefined;
  const dek = pick.dek ?? a.quick?.problem ?? a.vi?.description;
  return (
    <div className={`card group flex h-full flex-col overflow-hidden ${actions.toneFor(a.topic)}`}>
      <button
        onClick={() => actions.onOpen(a)}
        disabled={actions.opening !== null}
        aria-busy={actions.opening === a.id}
        className={`cover-art flex w-full flex-1 flex-col text-left disabled:cursor-wait ${lead ? "gap-4 p-6 sm:p-10" : "gap-2.5 p-5 sm:p-6"}`}
        style={coverStyle(a.id)}
      >
        <span className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <span className="inline-flex max-w-full items-center gap-2 rounded-full bg-surface/85 px-3 py-1 text-xs font-semibold shadow-sm backdrop-blur-sm">
            <span aria-hidden className="h-2 w-2 shrink-0 rounded-full bg-tone" />
            <span className="truncate">{actions.label(a.topic)}</span>
          </span>
          <ArticleMeta article={a} />
        </span>
        <span className={`font-display font-semibold tracking-[-0.01em] text-ink group-hover:underline group-hover:decoration-tone group-hover:underline-offset-4 ${lead ? "mt-auto pt-8 text-[30px] leading-[1.12] sm:text-[42px]" : "line-clamp-4 text-[21px] leading-snug"}`}>
          {title ?? a.title}
        </span>
        <span className={`text-body ${lead ? "max-w-2xl text-[16px] leading-relaxed sm:text-[17px]" : "line-clamp-3 text-[14.5px] leading-relaxed"}`}>
          {title ? dek : summaryOf(a.description)}
        </span>
        {title && (
          <span className={`text-xs leading-relaxed text-body ${lead ? "" : "line-clamp-2"}`}>
            <span className="font-semibold">{t("catalog.originalTitle")}: </span><i>{a.title}</i>
          </span>
        )}
      </button>
      <CardFoot article={a} actions={actions} />
    </div>
  );
}

/** The first thing on the page, and the reason to open it: one article large, two beside it, and the way to
 * every pick. */
function Featured({ picks, total, actions, onSeeAll }: { picks: Pick[]; total: number; actions: CardActions; onSeeAll: () => void }) {
  const t = useT();
  const [lead, ...others] = picks;
  if (!lead) return null;
  return (
    <section aria-labelledby="explore-featured" className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <h2 id="explore-featured" className="font-display text-2xl font-semibold leading-tight tracking-[-0.01em]">{t("catalog.featured")}</h2>
        {total > picks.length && <button type="button" className="btn-ghost shrink-0 px-3 text-sm text-accent-text" onClick={onSeeAll}>{t("catalog.seeMore")}</button>}
      </div>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1.65fr)_minmax(0,1fr)]">
        <FeaturedStory pick={lead} lead actions={actions} />
        <div className="grid gap-6">
          {others.map((pick) => <FeaturedStory key={pick.article.id} pick={pick} lead={false} actions={actions} />)}
        </div>
      </div>
    </section>
  );
}

/** Every topic as a door into its own list, in place of a row of articles for each. */
function TopicDoors({ topics, actions, onPick }: {
  topics: string[]; actions: CardActions; onPick: (name: string) => void;
}) {
  const t = useT();
  const lang = useLang();
  return (
    <section aria-labelledby="explore-topics" className="flex flex-col gap-4">
      <h2 id="explore-topics" className="font-display text-2xl font-semibold leading-tight tracking-[-0.01em]">{t("catalog.byTopic")}</h2>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {topics.map((name) => (
          <button key={name} type="button" onClick={() => onPick(name)} className={`card group flex h-full flex-col gap-1.5 p-5 text-left transition duration-200 hover:-translate-y-0.5 hover:shadow-float ${actions.toneFor(name)}`}>
            <span className="flex items-center gap-2.5">
              <span aria-hidden className="h-2.5 w-2.5 shrink-0 rounded-full bg-tone" />
              <span className="min-w-0 flex-1 font-display text-lg font-semibold leading-snug group-hover:underline group-hover:decoration-tone group-hover:underline-offset-4">{actions.label(name)}</span>
            </span>
            <span className="pl-5 text-sm leading-relaxed text-muted">{TOPICS.find((topic) => topic.name === name)?.about[lang]}</span>
          </button>
        ))}
      </div>
    </section>
  );
}

/** Narrowing a list: a chapter of the book (of the topic, when one is chosen), a grade of evidence, and the
 * picks alone. */
function Filters({ chapters, chapter, grade, picked, onChapter, onGrade, onPicked }: {
  chapters: NonNullable<Catalog["chapters"]>; chapter: number | null; grade: Grade | "";
  picked: boolean; onChapter: (chapter: number | null) => void; onGrade: (grade: Grade | "") => void; onPicked: (picked: boolean) => void;
}) {
  const t = useT();
  return (
    <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
      <button type="button" className="chip" aria-pressed={picked} onClick={() => onPicked(!picked)}>{t("catalog.pickedOnly")}</button>
      {chapters.length > 1 && (
        <label className="flex min-w-0 max-w-full flex-col gap-1.5 text-sm font-medium">
          {t("catalog.chapter")}
          <select className="input h-11 w-[min(100%,26rem)] py-0" value={chapter ?? ""} onChange={(e) => onChapter(e.target.value ? Number(e.target.value) : null)}>
            <option value="">{t("catalog.allChapters")}</option>
            {chapters.map((c) => <option key={c.number} value={c.number}>{c.number}. {c.title}</option>)}
          </select>
        </label>
      )}
      <div role="group" aria-labelledby="explore-grade" className="flex flex-col gap-1.5">
        <span id="explore-grade" className="text-sm font-medium">{t("catalog.grade")}</span>
        <div className="flex flex-wrap gap-2">
          <button type="button" className="chip" aria-pressed={!grade} onClick={() => onGrade("")}>{t("catalog.allGrades")}</button>
          {GRADES.map((g) => (
            <button key={g} type="button" className="chip" aria-pressed={grade === g} title={t(`catalog.grade${g}` as Key)} onClick={() => onGrade(g)}>
              {g}
            </button>
          ))}
        </div>
      </div>
      {grade && <p className="basis-full max-w-3xl text-sm leading-relaxed text-muted">{t(`catalog.grade${grade}` as Key)}</p>}
    </div>
  );
}

/** The shared library, the handbook's entries (CC BY): the whole of /explore. With nothing searched or
 * chosen it is a front page: a few featured articles, the topics, some more to read. A topic (?topic=) or every
 * article (?all) is a list of its own, a page at a time, and so is a search. Picking an article reads it here
 * (?read=), at the level the reader chooses; only a signed-in reader's pick with no Quick Read goes straight to
 * their library and the reader. */
export function SharedLibrary({ signedIn }: { signedIn: boolean }) {
  const router = useRouter();
  const params = useSearchParams();
  const qc = useQueryClient();
  const t = useT();
  const lang = useLang();
  const { showToast } = useUi();
  const topicName = (name: string) => (lang === "en" && TOPICS.find((topic) => topic.name === name)?.en) || name;
  const [opening, setOpening] = useState<string | null>(null);
  const [saved, setSaved] = useState<ReadonlySet<string>>(new Set());
  const [data, setData] = useState<Catalog | null>(null);
  const [q, setQ] = useState("");
  const topic = params.get("topic") ?? "";
  const chapterParam = Number(params.get("chapter"));
  const chapter = Number.isInteger(chapterParam) && chapterParam > 0 ? chapterParam : null;
  const gradeParam = params.get("grade") ?? "";
  const grade = (GRADES as readonly string[]).includes(gradeParam) ? (gradeParam as Grade) : "";
  const picked = params.has("featured");
  const everything = params.has("all") || picked || chapter !== null || grade !== "";
  const read = params.get("read");
  const [offset, setOffset] = useState(0);
  // What the articles on screen were fetched as, which may lag the filters while the next answer is on its way.
  const [frontPage, setFrontPage] = useState<boolean | null>(null);
  const [article, setArticle] = useState<Article | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const browsing = !q.trim() && !topic && !everything;

  useEffect(() => { setOffset(0); }, [topic, everything, chapter, grade, picked]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    const timer = setTimeout(() => {
      const query = new URLSearchParams(
        browsing
          ? { featured: "true", limit: String(FRONT_LIMIT) }
          : {
              q, topic, grade, offset: String(offset), limit: String(PAGE_SIZE),
              ...(chapter ? { chapter: String(chapter) } : {}), ...(picked ? { featured: "true" } : {}),
            },
      );
      fetch(`${API_URL}/api/catalog?${query}`, { signal: controller.signal })
        .then((r) => { if (!r.ok) throw new Error(); return r.json(); })
        .then((value: Catalog) => { setData(value); setFrontPage(browsing); setError(""); })
        .catch((e) => { if (e.name !== "AbortError") setError("catalog.loadError"); })
        .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    }, 250);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [q, topic, chapter, grade, picked, offset, browsing]);

  useEffect(() => {
    setArticle(null);
    if (!read) return;
    const controller = new AbortController();
    setError("");
    fetch(`${API_URL}/api/catalog/${encodeURIComponent(read)}`, { signal: controller.signal })
      .then((r) => { if (!r.ok) throw new Error(); return r.json(); })
      .then((full: Article) => setArticle(full))
      .catch((e) => { if (e.name !== "AbortError") setError("catalog.textError"); });
    return () => controller.abort();
  }, [read]);

  /** The list's address with `read` set or taken off, so going back returns to the same list. */
  function hrefReading(id: string | null) {
    const next = new URLSearchParams(params);
    if (id) next.set("read", id);
    else next.delete("read");
    const query = next.toString();
    return query ? `/explore?${query}` : "/explore";
  }

  async function openInReader(item: Article) {
    if (opening) return;
    setOpening(item.id);
    setError("");
    try {
      const doc = await api<DocumentDetail>(`/catalog/${item.id}/open`, { method: "POST" });
      void qc.invalidateQueries({ queryKey: documentsKey });
      router.push(`/reader/${doc.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : MSG["MSG-99"]);
      setOpening(null);
    }
  }

  function open(item: Article) {
    router.push(hrefReading(item.id));
  }

  /** Puts an article in the library and stays on the page. Saving one twice is harmless: the API keeps one copy. */
  async function save(item: Article) {
    if (opening) return;
    setOpening(item.id);
    try {
      await api<DocumentDetail>(`/catalog/${item.id}/open`, { method: "POST" });
      void qc.invalidateQueries({ queryKey: documentsKey });
      setSaved((current) => new Set(current).add(item.id));
      showToast(t("feed.saved"));
    } catch (e) {
      showToast(e instanceof Error ? e.message : MSG["MSG-99"]);
    } finally {
      setOpening(null);
    }
  }

  const topics = orderTopics(data?.topics ?? []);
  // Tones go by the set order of the topics, so a topic keeps its colour on every list and in either language.
  const toneFor = (name: string) => toneAt(topics.indexOf(name));
  const actions: CardActions = { label: topicName, toneFor, opening, saved, onOpen: open, onSave: signedIn ? (a) => void save(a) : undefined };
  const articles = data?.articles ?? [];
  const picks = featuredOf(articles);
  const more = readNext(articles, picks.map((p) => p.article));

  const goTo = (query: string) => { setQ(""); router.push(`/explore${query}`); };
  const pickTopic = (name: string) => goTo(name ? `?topic=${encodeURIComponent(name)}` : "?all");
  /** The same list with one filter changed and the search kept. */
  const filterBy = (change: { topic?: string; chapter?: number | null; grade?: Grade | ""; picked?: boolean }) => {
    const to = "topic" in change ? change.topic : topic;
    // Another topic has other chapters.
    const c = "topic" in change ? null : "chapter" in change ? change.chapter : chapter;
    const g = "grade" in change ? change.grade : grade;
    const p = "picked" in change ? change.picked : picked;
    const parts = [to ? `topic=${encodeURIComponent(to)}` : p ? "featured" : "all"];
    if (to && p) parts.push("featured");
    if (c) parts.push(`chapter=${c}`);
    if (g) parts.push(`grade=${g}`);
    router.push(`/explore?${parts.join("&")}`);
  };
  const size = Object.values(data?.topic_counts ?? {}).reduce((sum, n) => sum + n, 0);
  const chapters = (data?.chapters ?? []).filter((c) => !topic || c.topic === topic);
  const chapterTitle = chapters.find((c) => c.number === chapter)?.title;

  // A failed load keeps its key, so the message follows the language; a server's message is shown as it came.
  const errorText = error.startsWith("catalog.") ? t(error as Key) : error;

  if (read) {
    // The card's copy shows at once; the text follows from the API. A link opened afresh waits for it.
    const reading = article?.id === read ? article : articles.find((a) => a.id === read);
    if (!reading) {
      return (
        <div className="mx-auto flex max-w-3xl flex-col items-start gap-4">
          <button type="button" onClick={() => router.push(hrefReading(null))} className="btn-ghost -ml-3 px-3 text-sm text-accent-text">{t("catalog.back")}</button>
          {error ? <p role="alert" className="text-red-600">{errorText}</p> : <p role="status" className="text-muted">{t("catalog.loadingText")}</p>}
        </div>
      );
    }
    return (
      <ArticleReading
        key={reading.id}
        article={reading}
        topic={topicName(reading.topic)}
        signedIn={signedIn}
        error={errorText}
        opening={opening === reading.id}
        saved={saved.has(reading.id)}
        onBack={() => router.push(hrefReading(null))}
        onSave={() => void save(reading)}
        onOpenInReader={() => void openInReader(reading)}
      />
    );
  }

  const heading = topic ? topicName(topic) : picked ? t("catalog.picked") : everything ? t("catalog.everything") : "";
  return (
    <div className="flex flex-col gap-10 sm:gap-14">
      {/* One box in one place whatever the page shows: typing the first letter must not take the focus from it. */}
      <div className="flex flex-col gap-6">
        {heading ? (
          <div className="flex flex-col items-start gap-3">
            <button type="button" onClick={() => goTo("")} className="btn-ghost -ml-3 h-10 px-3 text-sm text-accent-text">{t("catalog.backHome")}</button>
            <h1 className="page-title">{heading}</h1>
            {(topic || picked) && (
              <p className="max-w-3xl text-base leading-relaxed text-muted sm:text-[17px]">
                {topic ? TOPICS.find((item) => item.name === topic)?.about[lang] : t("catalog.pickedAbout")}
              </p>
            )}
            {chapterTitle && <p className="font-display text-lg font-semibold leading-snug">{t("catalog.chapterOf", { n: chapter ?? 0, title: chapterTitle })}</p>}
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <p className="eyebrow uppercase">{t("explore.title")}</p>
            <h1 className="page-title max-w-4xl">{t("explore.headline")}</h1>
          </div>
        )}
        <div className="relative max-w-3xl">
          <Icon name="search" className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-muted" />
          <input aria-label={t("catalog.searchLabel")} placeholder={t("catalog.searchPlaceholder")} value={q} onChange={(e) => { setQ(e.target.value); setOffset(0); }} className="h-12 w-full rounded-full border border-line bg-surface pl-11 pr-4 text-[15px] text-ink shadow-card outline-none focus:border-focus" />
        </div>
      </div>

      {error && <p role="alert" className="text-red-600">{errorText}</p>}

      {browsing ? (
        frontPage === true ? (
          size === 0 ? <p>{t("catalog.empty")}</p> : (
            <>
              <Featured picks={picks} total={data?.total ?? 0} actions={actions} onSeeAll={() => goTo("?featured")} />
              <TopicDoors topics={topics} actions={actions} onPick={pickTopic} />
              {more.length > 0 && (
                <section aria-labelledby="explore-more" className="flex flex-col gap-4">
                  <div className="flex items-center justify-between gap-3">
                    <h2 id="explore-more" className="font-display text-2xl font-semibold leading-tight tracking-[-0.01em]">{t("catalog.more")}</h2>
                    <button type="button" className="btn-ghost shrink-0 px-3 text-sm text-accent-text" onClick={() => pickTopic("")}>{t("catalog.seeMore")}</button>
                  </div>
                  <div className="grid grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-3">
                    {/* A phone's page is long enough with three of them, and the rest are a tap away. */}
                    {more.map((a, i) => <div key={a.id} className={i >= 3 ? "max-md:hidden" : undefined}><ArticleTile article={a} showTopic actions={actions} /></div>)}
                  </div>
                </section>
              )}
            </>
          )
        ) : !error && <p role="status" className="text-sm text-muted">{t("catalog.loading")}</p>
      ) : (
        <div className="flex flex-col gap-6">
          <div role="group" aria-label={t("catalog.topicLabel")} className="-mx-4 flex gap-2 overflow-x-auto px-4 py-0.5 [scrollbar-width:none] sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0">
            <button type="button" className="chip" aria-pressed={!topic} onClick={() => filterBy({ topic: "" })}>{t("catalog.allTopics")}</button>
            {topics.map((name) => (
              <button key={name} type="button" className="chip" aria-pressed={topic === name} onClick={() => filterBy({ topic: name })}>{topicName(name)}</button>
            ))}
          </div>
          <Filters
            chapters={chapters}
            chapter={chapter}
            grade={grade}
            picked={picked}
            onChapter={(c) => filterBy({ chapter: c })}
            onGrade={(g) => filterBy({ grade: g })}
            onPicked={(p) => filterBy({ picked: p })}
          />
          <p role="status" className="text-sm text-muted">{(loading || frontPage !== false) && t("catalog.loading")}</p>
          {frontPage === false && (
            <>
              {!loading && data?.total === 0 && <p>{t("catalog.empty")}</p>}
              <div className="grid grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-3">
                {articles.map((a) => <ArticleTile key={a.id} article={a} showTopic={!topic} actions={actions} />)}
              </div>
              {data && data.total > PAGE_SIZE && <div className="flex items-center justify-center gap-5">
                <button disabled={offset === 0} onClick={() => setOffset(offset - PAGE_SIZE)} className="btn-outline">{t("catalog.prev")}</button>
                <span className="text-sm font-medium text-muted">{Math.floor(offset / PAGE_SIZE) + 1} / {Math.ceil(data.total / PAGE_SIZE)}</span>
                <button disabled={offset + PAGE_SIZE >= data.total} onClick={() => setOffset(offset + PAGE_SIZE)} className="btn-outline">{t("catalog.next")}</button>
              </div>}
            </>
          )}
        </div>
      )}
    </div>
  );
}

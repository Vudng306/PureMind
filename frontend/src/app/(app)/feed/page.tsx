"use client";

import { useEffect, useRef, useState } from "react";

import { useAuth } from "@/components/auth-provider";
import { CommunityFeed } from "@/components/community-feed";
import { ExploreChat } from "@/components/explore-chat";
import { FeedViewer } from "@/components/feed-viewer";
import { Icon } from "@/components/icons";
import { Alert, Spinner } from "@/components/ui";
import { formatDate } from "@/lib/documents";
import {
  TOPICS,
  readingMinutes,
  useFacets,
  useFeed,
  useFollowTopics,
  useRead,
  useSave,
  useTopics,
  type ArticleCard,
  type ArticleKind,
  type Topic,
} from "@/lib/feed";
import { useT, type Key } from "@/lib/i18n";
import { MSG } from "@/lib/messages";
import { useSignIn } from "@/lib/sign-in";
import { tagTone, toneAt } from "@/lib/tone";

const topicLabel = (topic: Topic) => `feed.topic.${topic}` as Key;
/** Each topic its own tone, the same wherever it shows. */
const topicTone = (topic: Topic) => toneAt(TOPICS.indexOf(topic));

/** "cards": the quick reads, which are the page. The full list and the chat are ways out of them, not rivals. */
type View = "cards" | "all" | "chat";

/** The feed: quick reads on the topics the user follows, chosen on the first visit. A visitor reads every topic,
 * and is asked to sign in for what needs an account: choosing topics, the community and the chat. */
export default function FeedPage() {
  const t = useT();
  const { session } = useAuth();
  const signIn = useSignIn();
  const guest = !session;
  const topics = useTopics();
  const [editing, setEditing] = useState(false);
  const [view, setView] = useState<View>("cards");
  const [community, setCommunity] = useState(false);
  const following = guest ? [...TOPICS] : (topics.data?.following ?? null);
  const reading = following !== null && !editing;
  const immersive = reading && view === "cards" && !community;
  const editTopics = guest ? signIn : () => setEditing(true);

  // Read here rather than with useSearchParams, which would make the whole page wait for the client.
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("scope") !== "community") return;
    if (guest) signIn();
    else setCommunity(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the address is read once, when the page opens
  }, []);

  function show(next: View) {
    if (guest && next === "chat") signIn();
    else setView(next);
  }

  /** Readers' posts are a place of their own, so the address says which one this is. */
  function showCommunity(on: boolean) {
    if (on && guest) return signIn();
    setCommunity(on);
    window.history.replaceState(null, "", on ? "/feed?scope=community" : "/feed");
  }

  return (
    // The card fills the screen, so it takes back what the app's page leaves around its content: see .feed-card.
    <div className={immersive ? "-mb-8 -mt-2 sm:-mt-6 lg:-mb-14" : ""}>
      <div className={`mx-auto flex w-full flex-col ${immersive ? "max-w-[1280px] gap-2 lg:gap-3" : "max-w-[820px] gap-7"}`}>
        <div className={immersive || community || (reading && view === "chat") ? "sr-only" : "flex flex-col gap-2"}>
          <h1 className="page-title">{t("feed.title")}</h1>
        </div>

        {/* Readers' posts ask for no topics, so a reader who has not chosen any can still open them. */}
        {community ? (
          <div className="flex flex-col gap-4">
            <div className="segmented self-start" role="group" aria-label={t("feed.scope")}>
              <button type="button" aria-pressed="false" onClick={() => showCommunity(false)}>
                {t("feed.scope.forYou")}
              </button>
              <button type="button" aria-pressed="true">
                {t("feed.scope.community")}
              </button>
            </div>
            <CommunityFeed />
          </div>
        ) : topics.isPending ? (
          <Spinner />
        ) : topics.isError ? (
          <div className="flex flex-col items-start gap-3">
            <Alert>{topics.error instanceof Error ? topics.error.message : MSG["MSG-99"]}</Alert>
            <button type="button" className="btn-outline" onClick={() => topics.refetch()}>
              {t("common.retry")}
            </button>
          </div>
        ) : following === null || editing ? (
          <TopicPicker
            counts={Object.fromEntries(topics.data.topics.map((x) => [x.id, x.count]))}
            initial={following ?? []}
            onDone={() => setEditing(false)}
            onCancel={following ? () => setEditing(false) : undefined}
          />
        ) : view === "cards" ? (
          <QuickReads following={following} onEdit={editTopics} onView={show} onCommunity={() => showCommunity(true)} />
        ) : (
          <>
            <button type="button" className="btn-ghost h-10 self-start px-3 text-sm" onClick={() => setView("cards")}>
              <Icon name="back" size={16} />
              {t("feed.back")}
            </button>
            {view === "chat" ? <ExploreChat /> : <AllArticles following={following} onEdit={editTopics} />}
          </>
        )}
      </div>
    </div>
  );
}

/** The switch above the viewer, and the viewer. */
function QuickReads({
  following,
  onEdit,
  onView,
  onCommunity,
}: {
  following: Topic[];
  onEdit: () => void;
  onView: (view: View) => void;
  onCommunity: () => void;
}) {
  const t = useT();
  const [byTopic, setByTopic] = useState(false);
  const [picked, setPicked] = useState<Topic | null>(null);
  const topic = byTopic ? (picked && following.includes(picked) ? picked : following[0]) : null;

  return (
    <div className="flex flex-col gap-2 lg:gap-3" style={byTopic ? ({ "--feed-chips": "48px" } as React.CSSProperties) : undefined}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 print:hidden">
        <div className="segmented" role="group" aria-label={t("feed.scope")}>
          <button type="button" aria-pressed={!byTopic} onClick={() => setByTopic(false)}>
            {t("feed.scope.forYou")}
          </button>
          <button type="button" aria-pressed={byTopic} onClick={() => setByTopic(true)}>
            {t("feed.scope.topics")}
          </button>
          <button type="button" aria-pressed="false" onClick={onCommunity}>
            {t("feed.scope.community")}
          </button>
        </div>
        {byTopic && (
          <div className="order-last -mx-4 flex w-[calc(100%+32px)] items-center gap-2 overflow-x-auto px-4 [scrollbar-width:none] lg:order-none lg:mx-0 lg:w-auto lg:min-w-0 lg:flex-1 lg:px-0">
            {following.map((x) => (
              <button
                key={x}
                type="button"
                className={`chip h-10 shrink-0 border-transparent bg-tone-bg text-tone-fg hover:bg-tone-bg aria-pressed:border-transparent aria-pressed:bg-tone aria-pressed:text-bg ${topicTone(x)}`}
                aria-pressed={topic === x}
                onClick={() => setPicked(x)}
              >
                {t(topicLabel(x))}
              </button>
            ))}
          </div>
        )}
        <div className="ml-auto flex items-center gap-1">
          <button type="button" className="btn-ghost h-11 px-3 text-sm" onClick={onEdit} aria-label={t("feed.editTopics")}>
            <Icon name="pencil" size={16} />
            <span className="hidden sm:inline">{t("feed.editTopics")}</span>
          </button>
          <FeedMenu onView={onView} />
        </div>
      </div>
      <FeedViewer key={topic ?? "for_you"} topic={topic} onTopics={onEdit} onAll={() => onView("all")} />
    </div>
  );
}

/** The ways out of the cards, kept out of the reader's eye. */
function FeedMenu({ onView }: { onView: (view: View) => void }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={root} className="relative">
      <button type="button" className="icon-btn" aria-label={t("feed.more")} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <Icon name="more" size={20} />
      </button>
      {open && (
        <div role="menu" className="absolute right-0 top-[48px] z-30 flex w-[230px] flex-col gap-0.5 rounded-[14px] border border-line bg-surface p-1.5 shadow-float">
          {(
            [
              ["all", "feed.menu.all", "file"],
              ["chat", "feed.menu.chat", "spark"],
            ] as const
          ).map(([view, label, icon]) => (
            <button
              key={view}
              type="button"
              role="menuitem"
              className="flex h-11 items-center gap-2.5 rounded-[10px] px-2.5 text-left text-sm hover:bg-soft"
              onClick={() => onView(view)}
            >
              <Icon name={icon} size={16} />
              {t(label)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function TopicPicker({
  counts,
  initial,
  onDone,
  onCancel,
}: {
  counts: Record<string, number>;
  initial: Topic[];
  onDone: () => void;
  onCancel?: () => void;
}) {
  const t = useT();
  const follow = useFollowTopics();
  const [chosen, setChosen] = useState<Topic[]>(initial);

  function toggle(topic: Topic) {
    setChosen((c) => (c.includes(topic) ? c.filter((x) => x !== topic) : [...c, topic]));
  }

  async function save(topics: Topic[]) {
    await follow.mutateAsync(topics);
    onDone();
  }

  return (
    <section className="card flex flex-col gap-5 p-6 sm:p-8" aria-labelledby="pick-title">
      <div className="flex flex-col gap-2">
        <h2 id="pick-title" className="font-serif text-[28px] font-medium leading-tight">
          {t("feed.pickTitle")}
        </h2>
        <p className="text-[15px] leading-relaxed text-muted">{t("feed.pickLead")}</p>
      </div>
      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
        {TOPICS.map((topic) => {
          const on = chosen.includes(topic);
          return (
            <button
              key={topic}
              type="button"
              role="checkbox"
              aria-checked={on}
              onClick={() => toggle(topic)}
              className={`flex min-h-[56px] items-center gap-3 rounded-[12px] border px-4 text-left transition-colors ${
                on ? "border-ink bg-ink text-bg" : "border-field hover:bg-soft"
              }`}
            >
              <span
                aria-hidden
                className={`grid h-5 w-5 shrink-0 place-items-center rounded-full border ${on ? "border-bg" : "border-field"}`}
              >
                {on && <span className="h-2.5 w-2.5 rounded-full bg-bg" />}
              </span>
              <span className="flex-1 text-[15px] font-medium">{t(topicLabel(topic))}</span>
              <span className={`text-sm ${on ? "text-bg/80" : "text-muted"}`}>{t("feed.pickCount", { n: counts[topic] ?? 0 })}</span>
            </button>
          );
        })}
      </div>
      {follow.isError && <Alert>{follow.error instanceof Error ? follow.error.message : MSG["MSG-99"]}</Alert>}
      <div className="flex flex-wrap items-center gap-2.5">
        <button
          type="button"
          className="btn-primary h-12 px-6"
          disabled={!chosen.length || follow.isPending}
          onClick={() => void save(chosen)}
        >
          {chosen.length ? t("feed.startN", { n: chosen.length }) : t("feed.start")}
          <Icon name="arrow" size={16} />
        </button>
        {onCancel ? (
          <button type="button" className="btn-ghost h-12 px-4" onClick={onCancel}>
            {t("common.cancel")}
          </button>
        ) : (
          <button type="button" className="btn-ghost h-12 px-4" disabled={follow.isPending} onClick={() => void save([...TOPICS])}>
            {t("feed.skip")}
          </button>
        )}
      </div>
    </section>
  );
}

/** Every article of the topics followed, for readers who would rather pick from a list. */
function AllArticles({ following, onEdit }: { following: Topic[]; onEdit: () => void }) {
  const t = useT();
  const [topic, setTopic] = useState<Topic | null>(null);
  const [kind, setKind] = useState<ArticleKind | null>(null);
  const [tag, setTag] = useState<string | null>(null);

  function pickTopic(x: Topic | null) {
    setTopic(x);
    setTag(null);
  }
  function pickKind(x: ArticleKind | null) {
    setKind(x);
    setTag(null);
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="-mx-4 flex items-center gap-2 overflow-x-auto px-4 pb-1 [scrollbar-width:none] sm:mx-0 sm:px-0">
        <button type="button" className="chip h-9" aria-pressed={topic === null} onClick={() => pickTopic(null)}>
          {t("feed.yourTopics")}
        </button>
        {following.map((x) => (
          <button
            key={x}
            type="button"
            className={`chip h-9 border-transparent bg-tone-bg text-tone-fg hover:bg-tone-bg aria-pressed:border-transparent aria-pressed:bg-tone aria-pressed:text-bg ${topicTone(x)}`}
            aria-pressed={topic === x}
            onClick={() => pickTopic(x)}
          >
            {t(topicLabel(x))}
          </button>
        ))}
        <button type="button" className="chip h-9 border-dashed text-muted" onClick={onEdit}>
          <Icon name="plus" size={14} />
          {t("feed.editTopics")}
        </button>
      </div>
      <Filters topic={topic} kind={kind} tag={tag} onKind={pickKind} onTag={setTag} />
      <ArticleList topic={topic} kind={kind} tag={tag} onTag={setTag} />
    </div>
  );
}

/** Narrow the list by what the articles are, and by the tags they carry. */
function Filters({
  topic,
  kind,
  tag,
  onKind,
  onTag,
}: {
  topic: Topic | null;
  kind: ArticleKind | null;
  tag: string | null;
  onKind: (kind: ArticleKind | null) => void;
  onTag: (tag: string | null) => void;
}) {
  const t = useT();
  const facets = useFacets(topic, kind);
  const kinds = facets.data?.kinds ?? [];
  // A tag on a single article says little; the one picked stays whatever its count.
  const tags = (facets.data?.tags ?? []).filter((x) => x.count > 1 || x.tag === tag);
  const shown = tag && !tags.some((x) => x.tag === tag) ? [{ tag, count: 0 }, ...tags] : tags;
  if (kinds.length < 2 && shown.length === 0) return null;

  return (
    <div className="flex flex-col gap-2">
      {kinds.length > 1 && (
        <div
          role="group"
          aria-label={t("feed.filter.kind")}
          className="-mx-4 flex items-center gap-2 overflow-x-auto px-4 pb-1 [scrollbar-width:none] sm:mx-0 sm:px-0"
        >
          <button type="button" className="chip h-8 text-[13px]" aria-pressed={kind === null} onClick={() => onKind(null)}>
            {t("feed.filter.allKinds")}
          </button>
          {kinds.map((k) => (
            <button
              key={k.id}
              type="button"
              className="chip h-8 text-[13px]"
              aria-pressed={kind === k.id}
              onClick={() => onKind(k.id)}
            >
              {t(`feed.kind.${k.id}` as Key)}
              <span className="text-muted">{k.count}</span>
            </button>
          ))}
        </div>
      )}
      {shown.length > 0 && (
        <div
          role="group"
          aria-label={t("feed.filter.tags")}
          className="-mx-4 flex items-center gap-1.5 overflow-x-auto px-4 pb-1 [scrollbar-width:none] sm:mx-0 sm:px-0"
        >
          {shown.map((x) => (
            <button
              key={x.tag}
              type="button"
              className={`chip h-7 border-transparent bg-tone-bg text-xs text-tone-fg hover:bg-tone-bg aria-pressed:border-transparent aria-pressed:bg-tone aria-pressed:text-bg ${tagTone(x.tag)}`}
              aria-pressed={tag === x.tag}
              onClick={() => onTag(tag === x.tag ? null : x.tag)}
            >
              {x.tag}
              {tag === x.tag && <Icon name="x" size={12} />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function ArticleList({
  topic,
  kind,
  tag,
  onTag,
}: {
  topic: Topic | null;
  kind: ArticleKind | null;
  tag: string | null;
  onTag: (tag: string) => void;
}) {
  const t = useT();
  const feed = useFeed(topic, kind, tag);
  const articles = feed.data?.pages.flatMap((p) => p.articles) ?? [];

  return (
    <div className="flex flex-col gap-6">
      {feed.isPending ? (
        <Spinner />
      ) : feed.isError ? (
        <div className="flex flex-col items-start gap-3">
          <Alert>{feed.error instanceof Error ? feed.error.message : MSG["MSG-99"]}</Alert>
          <button type="button" className="btn-outline" onClick={() => feed.refetch()}>
            {t("common.retry")}
          </button>
        </div>
      ) : articles.length === 0 ? (
        <p className="rounded-[14px] border border-dashed border-field px-6 py-12 text-center text-muted">
          {t(kind || tag ? "feed.emptyFiltered" : topic ? "feed.empty" : "feed.emptyAll")}
        </p>
      ) : (
        <>
          <ul className="flex flex-col gap-4">
            {articles.map((a) => (
              <li key={a.id}>
                <ArticleItem article={a} onTag={onTag} />
              </li>
            ))}
          </ul>
          {feed.hasNextPage ? (
            <button
              type="button"
              className="btn-outline h-11 self-center px-6"
              disabled={feed.isFetchingNextPage}
              onClick={() => void feed.fetchNextPage()}
            >
              {feed.isFetchingNextPage
                ? t("common.loading")
                : t("common.loadMore", { n: (feed.data?.pages.at(-1)?.total ?? 0) - articles.length })}
            </button>
          ) : (
            <p className="text-center text-sm text-muted">{t("feed.end")}</p>
          )}
        </>
      )}
    </div>
  );
}

function ArticleItem({ article, onTag }: { article: ArticleCard; onTag: (tag: string) => void }) {
  const t = useT();
  const { read, opened, pending, error } = useRead(article.id, article.document_id);
  const { save, saved, saving } = useSave(article.id, article.document_id);

  const meta = [
    t(`feed.kind.${article.kind}` as Key),
    t("common.minutesRead", { n: readingMinutes(article.word_count) }),
    article.published_at ? formatDate(article.published_at) : null,
  ].filter(Boolean);

  return (
    <article className="card flex gap-5 p-5 sm:p-6">
      <div className="flex min-w-0 flex-1 flex-col gap-2.5">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="eyebrow uppercase">{article.source_name}</span>
          {article.language !== "vi" && (
            <span className="rounded-[5px] border border-line px-1.5 text-[11px] font-semibold text-muted" title={t("feed.inEnglish")}>
              {article.language.toUpperCase()}
            </span>
          )}
          {article.topics.map((x) => (
            <span key={x} className={`inline-flex items-center gap-1.5 text-xs text-muted ${topicTone(x)}`}>
              <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-tone" />
              {t(topicLabel(x))}
            </span>
          ))}
        </div>
        <h2 className="font-serif text-[22px] font-medium leading-snug sm:text-[24px]">
          <button type="button" className="text-left hover:underline hover:underline-offset-4" onClick={() => void read()}>
            {article.title}
          </button>
        </h2>
        {article.summary && <p className="line-clamp-3 text-[15px] leading-relaxed text-body">{article.summary}</p>}
        {article.based_on && (
          <p className="line-clamp-2 text-sm text-muted">
            <a href={article.based_on.url} target="_blank" rel="noreferrer" className="hover:text-ink hover:underline">
              {t("feed.basedOn", { title: article.based_on.title, source: article.based_on.source_name })}
            </a>
          </p>
        )}
        <p className="text-sm text-muted">
          {[article.authors, ...meta].filter(Boolean).join(" · ")}
        </p>
        {article.tags.length > 0 && (
          <ul className="flex flex-wrap gap-1.5" aria-label={t("feed.filter.tags")}>
            {article.tags.slice(0, 5).map((x) => (
              <li key={x}>
                <button
                  type="button"
                  className={`rounded-full bg-tone-bg px-2.5 py-0.5 text-xs font-medium text-tone-fg transition-opacity hover:opacity-80 ${tagTone(x)}`}
                  onClick={() => onTag(x)}
                >
                  {x}
                </button>
              </li>
            ))}
          </ul>
        )}
        {error && <Alert>{error}</Alert>}
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <button type="button" className={opened ? "btn-dark h-10 px-4" : "btn-primary h-10 px-4"} disabled={pending} onClick={() => void read()}>
            {pending ? t("feed.opening") : t(opened ? "feed.continue" : "feed.read")}
            <Icon name="arrow" size={16} />
          </button>
          <a href={article.based_on?.url ?? article.url} target="_blank" rel="noreferrer" className="btn-ghost h-10 px-3 text-sm">
            {t("feed.original")} ↗
          </a>
          <button
            type="button"
            className="btn-ghost h-10 px-3 text-sm"
            disabled={saving || saved}
            aria-pressed={saved}
            onClick={() => void save()}
          >
            <Icon name={saved ? "check" : "bookmark"} size={16} />
            {t(saved ? "feed.savedShort" : "feed.saveLater")}
          </button>
          <span className="text-xs text-muted">{t("feed.licence", { license: article.license })}</span>
        </div>
      </div>
      {article.image_url && (
        // eslint-disable-next-line @next/next/no-img-element -- remote CC BY chart image, sized by CSS
        <img
          src={article.image_url}
          alt=""
          loading="lazy"
          className="hidden h-[120px] w-[160px] shrink-0 rounded-[10px] border border-line object-cover sm:block"
        />
      )}
    </article>
  );
}

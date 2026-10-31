"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

import { ExploreChat } from "@/components/explore-chat";
import { Icon } from "@/components/icons";
import { LanguageToggle } from "@/components/language-toggle";
import { Alert, Spinner } from "@/components/ui";
import { UserMenu } from "@/components/user-menu";
import { useHighlights } from "@/lib/annotations";
import { progressOf } from "@/lib/doc-view";
import { formatDate, useDocuments } from "@/lib/documents";
import {
  TOPICS,
  readingMinutes,
  useFeed,
  useFollowTopics,
  useRead,
  useSave,
  useShorts,
  useTopics,
  type ArticleCard,
  type ShortCard,
  type Topic,
} from "@/lib/feed";
import { useT, type Key } from "@/lib/i18n";
import { MSG } from "@/lib/messages";
import { useAccount } from "@/lib/queries";
import { studyApi } from "@/lib/study";

const topicLabel = (topic: Topic) => `feed.topic.${topic}` as Key;

/** The feed: openly licensed articles on the topics the user follows, chosen on the first visit. It is a place
 * of its own, apart from the library and its tools: its own header, no app bar or dock. */
export default function FeedPage() {
  const t = useT();
  const topics = useTopics();
  const [editing, setEditing] = useState(false);
  const [mode, setMode] = useState<Mode>("shorts");
  const following = topics.data?.following ?? null;
  const immersive = mode === "shorts" && following !== null && !editing;
  const reading = following !== null && !editing;
  const chatting = reading && mode === "chat"; // the chat has a heading of its own

  return (
    <div className="app-backdrop min-h-screen">
      <FeedHeader mode={reading ? mode : null} onMode={setMode} />
      <main className={`px-4 pt-4 sm:px-8 sm:pt-6 ${immersive ? "pb-3" : "pb-10"}`}>
        <div className={`mx-auto ${reading ? "max-w-[1180px] xl:grid xl:grid-cols-[minmax(0,1fr)_300px] xl:gap-10" : "max-w-[820px]"}`}>
          <div className={`mx-auto flex w-full max-w-[820px] flex-col ${immersive ? "gap-3" : "gap-7"}`}>
            <div className={immersive || chatting ? "sr-only" : "flex flex-col gap-2"}>
              <h1 className="font-serif text-4xl font-medium leading-[1.1] sm:text-5xl">{t("feed.title")}</h1>
              <p className="max-w-2xl text-base leading-relaxed text-muted">{t("feed.lede")}</p>
            </div>

            {topics.isPending ? (
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
            ) : chatting ? (
              <ExploreChat />
            ) : (
              <Feed following={following} mode={mode} onMode={setMode} onEdit={() => setEditing(true)} />
            )}
          </div>
          {reading && <FeedRail />}
        </div>
      </main>
    </div>
  );
}

/** The feed's own bar: how to read it in the middle, the way back to the library on the right. */
function FeedHeader({ mode, onMode }: { mode: Mode | null; onMode: (mode: Mode) => void }) {
  const t = useT();
  const { data: user } = useAccount();

  return (
    <header className="glass sticky top-0 z-20 border-b print:hidden">
      <div className="relative flex h-[60px] items-center gap-2 px-4 sm:gap-3 sm:px-8">
        {/* On a phone the three ways to read need the room; the library button is still there. */}
        <Link href="/feed" className={`shrink-0 items-baseline gap-2 ${mode ? "hidden sm:flex" : "flex"}`}>
          <span className="font-serif text-[22px] font-semibold">PureMind</span>
          <span className="hidden text-sm text-muted md:inline">{t("feed.title")}</span>
        </Link>
        <span className="flex-1" />
        {mode && (
          <div
            className="flex min-w-0 gap-1 overflow-x-auto rounded-full bg-soft p-1 [scrollbar-width:none] sm:shrink-0 lg:absolute lg:left-1/2 lg:-translate-x-1/2"
            role="tablist"
            aria-label={t("feed.mode")}
          >
            {(["shorts", "full", "chat"] as const).map((m) => (
              <button
                key={m}
                type="button"
                role="tab"
                aria-selected={mode === m}
                onClick={() => onMode(m)}
                className={`flex h-8 shrink-0 items-center whitespace-nowrap rounded-full px-2 text-[13px] transition-colors min-[400px]:px-2.5 min-[400px]:text-sm sm:px-3.5 ${
                  mode === m ? "bg-surface font-semibold text-ink shadow-sm" : "text-muted hover:text-ink"
                }`}
              >
                {t(`feed.mode.${m}`)}
              </button>
            ))}
          </div>
        )}
        <Link href="/library" className="glass icon-btn shrink-0 border lg:w-auto lg:gap-2 lg:px-4" aria-label={t("nav.library")}>
          <Icon name="book" />
          <span className="hidden text-[15px] lg:inline">{t("nav.library")}</span>
        </Link>
        <LanguageToggle className="glass hidden rounded-full md:flex" />
        <UserMenu user={user} />
      </div>
    </header>
  );
}

const isDue = (set: { progress: Record<string, { due: string }> }, i: number, now: number) =>
  !set.progress[i] || Date.parse(set.progress[i].due) <= now;

/** Beside the feed on a wide screen, from the user's own things: what they are reading, the cards to
 * review today and one of their highlights to think about again. */
function FeedRail() {
  const t = useT();
  const docs = useDocuments("created_desc");
  const sets = useQuery({ queryKey: ["study"], queryFn: studyApi.list });
  const { data: highlights } = useHighlights();
  const [now] = useState(() => Date.now());

  const all = docs.data ?? [];
  const titles = new Map(all.map((d) => [d.id, d.title]));
  const reading = all
    .filter((d) => {
      const pct = progressOf(d);
      return pct > 0 && pct < 100;
    })
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
    .slice(0, 3);
  const flashcards = (sets.data ?? []).filter((s) => s.kind === "flashcards");
  const due = flashcards.reduce((n, s) => n + s.items.filter((_, i) => isDue(s, i, now)).length, 0);
  // The same highlight all day, another one tomorrow.
  const own = highlights.filter((h) => titles.has(h.docId) && h.text.trim());
  const idea = own.length ? own[Math.floor(now / 86_400_000) % own.length] : null;

  return (
    <aside className="sticky top-[84px] hidden flex-col gap-4 self-start xl:flex" aria-label={t("feed.rail.aria")}>
      <section className="card flex flex-col gap-3 p-5">
        <h2 className="eyebrow uppercase">{t("feed.rail.reading")}</h2>
        {reading.length ? (
          <ul className="flex flex-col gap-3.5">
            {reading.map((d) => {
              const pct = progressOf(d);
              return (
                <li key={d.id}>
                  <Link href={`/reader/${d.id}`} className="group flex flex-col gap-1.5">
                    <span className="line-clamp-2 text-[15px] font-medium leading-snug group-hover:underline group-hover:underline-offset-4">
                      {d.title}
                    </span>
                    <span className="flex items-center gap-2.5">
                      <span className="h-1 flex-1 overflow-hidden rounded-full bg-soft">
                        <span className="block h-full rounded-full bg-accent" style={{ width: `${pct}%` }} />
                      </span>
                      <span className="text-xs tabular-nums text-muted">{pct}%</span>
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="text-sm leading-relaxed text-muted">{t("feed.rail.readingEmpty")}</p>
        )}
      </section>

      <section className="card flex flex-col gap-2 p-5">
        <h2 className="eyebrow uppercase">{t("feed.rail.due")}</h2>
        {flashcards.length ? (
          <>
            <p className="flex items-baseline gap-2">
              <span className="font-serif text-4xl font-medium tabular-nums">{due}</span>
              <span className="text-sm text-muted">{t("feed.rail.dueCards")}</span>
            </p>
            <Link href="/study" className="self-start text-sm font-semibold text-accent hover:underline">
              {t(due ? "feed.rail.dueGo" : "feed.rail.dueOpen")} →
            </Link>
          </>
        ) : (
          <p className="text-sm leading-relaxed text-muted">
            {t("feed.rail.dueEmpty")}{" "}
            <Link href="/study" className="font-semibold text-accent hover:underline">
              {t("feed.rail.dueOpen")} →
            </Link>
          </p>
        )}
      </section>

      <section className="card flex flex-col gap-3 p-5">
        <h2 className="eyebrow uppercase">{t("feed.rail.idea")}</h2>
        {idea ? (
          <>
            <blockquote className="line-clamp-6 border-l-2 border-accent pl-3 font-serif text-[17px] leading-relaxed text-ink">
              {idea.text}
            </blockquote>
            <Link href={`/reader/${idea.docId}?hl=${idea.id}`} className="line-clamp-1 text-sm text-muted hover:text-ink hover:underline">
              {titles.get(idea.docId)}
            </Link>
          </>
        ) : (
          <p className="text-sm leading-relaxed text-muted">{t("feed.rail.ideaEmpty")}</p>
        )}
      </section>
    </aside>
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

/** "chat": talk with the AI about what to learn, and get the feed's articles on it. */
type Mode = "shorts" | "full" | "chat";

function Feed({
  following,
  mode,
  onMode,
  onEdit,
}: {
  following: Topic[];
  mode: Mode;
  onMode: (mode: Mode) => void;
  onEdit: () => void;
}) {
  const t = useT();
  const [topic, setTopic] = useState<Topic | null>(null);

  return (
    <div className={`flex flex-col ${mode === "shorts" ? "gap-3" : "gap-5"}`}>
      <div className="-mx-4 flex items-center gap-2 overflow-x-auto px-4 pb-1 [scrollbar-width:none] sm:mx-0 sm:px-0">
        <button type="button" className="chip h-9" aria-pressed={topic === null} onClick={() => setTopic(null)}>
          {t("feed.yourTopics")}
        </button>
        {following.map((x) => (
          <button key={x} type="button" className="chip h-9" aria-pressed={topic === x} onClick={() => setTopic(x)}>
            {t(topicLabel(x))}
          </button>
        ))}
        <button type="button" className="chip h-9 border-dashed text-muted" onClick={onEdit}>
          <Icon name="plus" size={14} />
          {t("feed.editTopics")}
        </button>
      </div>

      {mode === "shorts" ? (
        <ShortStream key={topic ?? ""} topic={topic} onFull={() => onMode("full")} />
      ) : (
        <ArticleList topic={topic} />
      )}
    </div>
  );
}

// Each topic's colours for the posts' backgrounds: deep enough for white text in either theme.
const TOPIC_COLORS: Record<Topic, [string, string]> = {
  science: ["#2c5d8f", "#0c1a2b"],
  technology: ["#4b4fa3", "#12132e"],
  health: ["#2f7a69", "#0b221d"],
  mind: ["#7a4c94", "#1c1026"],
  philosophy: ["#8a6a3a", "#22180c"],
  environment: ["#3f7f45", "#0f2412"],
  economy: ["#94602c", "#2a170a"],
  law: ["#56607a", "#15181f"],
  society: ["#94465a", "#27101a"],
  education: ["#3a7394", "#0f1e28"],
  family: ["#a0623f", "#2a150c"],
  history: ["#7d6440", "#1f170d"],
  culture: ["#8f3f7d", "#260f21"],
  arts: ["#2f8a86", "#0c2524"],
  travel: ["#9a8236", "#28200b"],
  sports: ["#a04646", "#2a0f0f"],
};

function backdrop(topic: Topic | undefined, id: string): string {
  const [light, dark] = TOPIC_COLORS[topic ?? "science"];
  // Where the light falls changes from post to post, so two posts on a topic do not look the same.
  const x = 15 + (parseInt(id.slice(0, 2), 16) % 70);
  return `radial-gradient(90% 60% at ${x}% 8%, ${light} 0%, transparent 70%), linear-gradient(170deg, ${light} -20%, ${dark} 75%)`;
}

/** Quick reads full screen, one post at a time: swipe up for the next post, sideways through its pages. */
function ShortStream({ topic, onFull }: { topic: Topic | null; onFull: () => void }) {
  const t = useT();
  const feed = useShorts(topic);
  const shorts = feed.data?.pages.flatMap((p) => p.shorts) ?? [];
  const total = feed.data?.pages.at(-1)?.total ?? 0;
  const box = useRef<HTMLDivElement>(null);
  const [index, setIndex] = useState(0);
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = feed;

  useEffect(() => {
    if (hasNextPage && !isFetchingNextPage && index >= shorts.length - 3) void fetchNextPage();
  }, [index, shorts.length, hasNextPage, isFetchingNextPage, fetchNextPage]);

  const onScroll = useCallback(() => {
    const el = box.current;
    if (el) setIndex(Math.round(el.scrollTop / el.clientHeight));
  }, []);

  function go(step: number) {
    const el = box.current;
    if (el) el.scrollTo({ top: (index + step) * el.clientHeight, behavior: "smooth" });
  }

  function turn(step: number) {
    const pager = box.current?.children[index]?.querySelector<HTMLElement>("[data-pager]");
    pager?.scrollBy({ left: step * pager.clientWidth, behavior: "smooth" });
  }

  function onKey(e: React.KeyboardEvent) {
    const moves: Record<string, () => void> = {
      ArrowDown: () => go(1),
      ArrowUp: () => go(-1),
      ArrowRight: () => turn(1),
      ArrowLeft: () => turn(-1),
    };
    if (moves[e.key]) {
      e.preventDefault();
      moves[e.key]();
    }
  }

  if (feed.isPending) return <Spinner />;
  if (feed.isError)
    return (
      <div className="flex flex-col items-start gap-3">
        <Alert>{feed.error instanceof Error ? feed.error.message : MSG["MSG-99"]}</Alert>
        <button type="button" className="btn-outline" onClick={() => feed.refetch()}>
          {t("common.retry")}
        </button>
      </div>
    );
  if (shorts.length === 0)
    return (
      <div className="flex flex-col items-center gap-4 rounded-[14px] border border-dashed border-field px-6 py-12 text-center text-muted">
        <p className="max-w-md">{t("feed.short.empty")}</p>
        <button type="button" className="btn-outline" onClick={onFull}>
          {t("feed.short.toFull")}
        </button>
      </div>
    );

  return (
    <div className="relative -mx-4 sm:mx-auto sm:w-[min(100%,460px)]">
      <div
        ref={box}
        onScroll={onScroll}
        onKeyDown={onKey}
        tabIndex={0}
        aria-label={t("feed.mode.shorts")}
        className="h-[max(480px,calc(100dvh-132px))] snap-y snap-mandatory overflow-y-auto overscroll-contain bg-[#121110] [scrollbar-width:none] focus-visible:outline-offset-4 sm:h-[max(520px,min(calc(100dvh-170px),860px))] sm:rounded-[28px] sm:shadow-pop md:h-[max(520px,min(calc(100dvh-180px),860px))]"
      >
        {shorts.map((s, i) => (
          <ShortSlide key={s.id} short={s} position={i + 1} total={total} onNext={() => go(1)} />
        ))}
        <div className="flex h-full snap-start flex-col items-center justify-center gap-4 px-8 text-center text-white/80">
          {hasNextPage ? (
            <Spinner />
          ) : (
            <>
              <p className="font-serif text-2xl text-white">{t("feed.short.end")}</p>
              <button type="button" className="btn h-11 bg-white px-5 font-semibold text-[#1c1a17] hover:bg-white/90" onClick={onFull}>
                {t("feed.short.toFull")}
              </button>
            </>
          )}
        </div>
      </div>
      <div className="absolute -right-16 top-1/2 hidden -translate-y-1/2 flex-col gap-2 sm:flex">
        <button type="button" className="icon-btn border border-line bg-surface" disabled={index === 0} onClick={() => go(-1)} aria-label={t("feed.short.prev")}>
          <Icon name="up" size={20} />
        </button>
        <button type="button" className="icon-btn border border-line bg-surface" disabled={index >= shorts.length} onClick={() => go(1)} aria-label={t("feed.short.next")}>
          <Icon name="down" size={20} />
        </button>
      </div>
    </div>
  );
}

/** One post: a cover, then the hook, the points and the thing to keep, a page each, side by side. */
function ShortSlide({ short, position, total, onNext }: { short: ShortCard; position: number; total: number; onNext: () => void }) {
  const t = useT();
  const { read, opened, pending, error } = useRead(short.read_id, short.document_id);
  const { save, saved, saving } = useSave(short.read_id, short.document_id);
  const [page, setPage] = useState(0);
  const [copied, setCopied] = useState(false);
  const pager = useRef<HTMLDivElement>(null);
  const pages = 2 + short.points.length + 1; // cover, hook, points, takeaway
  const readLabel = t(short.read_kind === "guide" ? "feed.short.readGuide" : "feed.short.readOn", {
    n: readingMinutes(short.read_words),
  });

  function show(i: number) {
    const el = pager.current;
    if (el) el.scrollTo({ left: i * el.clientWidth, behavior: "smooth" });
  }

  async function share() {
    const data = { title: short.title, url: short.original_url };
    try {
      if (navigator.share) return await navigator.share(data);
      await navigator.clipboard.writeText(`${short.title}\n${short.original_url}`);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // The reader closed the share sheet.
    }
  }

  const rail = [
    { icon: "file" as const, label: t("feed.read"), onClick: () => void read(), busy: pending },
    {
      icon: saved ? ("check" as const) : ("bookmark" as const),
      label: t(saved ? "feed.savedShort" : "feed.save"),
      onClick: () => void save(),
      busy: saving || saved,
    },
    { icon: "link" as const, label: t("feed.original"), href: short.original_url },
    { icon: copied ? ("check" as const) : ("upload" as const), label: t(copied ? "feed.short.copied" : "feed.short.share"), onClick: () => void share() },
  ];

  return (
    <section
      className="relative h-full snap-start snap-always overflow-hidden text-white"
      style={{ background: backdrop(short.topics[0], short.id) }}
      aria-label={short.title}
    >
      <div
        ref={pager}
        data-pager
        onScroll={(e) => setPage(Math.round(e.currentTarget.scrollLeft / e.currentTarget.clientWidth))}
        className="flex h-full snap-x snap-mandatory overflow-x-auto overscroll-x-contain [scrollbar-width:none]"
      >
        {/* Cover */}
        <div className="relative flex h-full w-full shrink-0 snap-start flex-col justify-end gap-4 px-6 pb-28 pr-24 pt-16">
          <span aria-hidden className="pointer-events-none absolute -top-6 right-4 select-none font-serif text-[220px] leading-none text-white/10">
            “
          </span>
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-full border border-white/25 bg-white/10 px-3 py-1 text-xs font-semibold backdrop-blur">
              {short.topics.map((x) => t(topicLabel(x))).join(" · ")}
            </span>
            <span className="text-xs text-white/70">{t("feed.short.minute")}</span>
          </div>
          <h2 className="font-serif text-[32px] font-semibold leading-[1.12] [text-wrap:balance] sm:text-[36px]">{short.title}</h2>
          <button type="button" className="self-start text-sm text-white/70 hover:text-white" onClick={() => show(1)}>
            {t("feed.short.swipe")} »
          </button>
        </div>

        {/* Hook */}
        <Page>
          <p className="text-[24px] font-medium leading-[1.4] sm:text-[26px]">{short.hook}</p>
        </Page>

        {short.points.map((point, i) => (
          <Page key={i}>
            <span className="font-serif text-[64px] leading-none text-white/30">{String(i + 1).padStart(2, "0")}</span>
            <p className="text-[23px] font-medium leading-[1.4] sm:text-[25px]">{point}</p>
          </Page>
        ))}

        {/* The thing to keep, and where to read on */}
        <Page>
          <div className="rounded-[18px] border-l-4 border-white/80 bg-white/10 p-5 backdrop-blur">
            <p className="mb-2 text-xs font-bold uppercase tracking-[0.12em] text-white/80">💡 {t("feed.short.keep")}</p>
            <p className="text-[20px] font-medium leading-[1.45]">{short.takeaway}</p>
          </div>
          {error && <Alert>{error}</Alert>}
          <div className="flex flex-col gap-2.5">
            <button
              type="button"
              className="btn h-12 bg-white font-semibold text-[#1c1a17] hover:bg-white/90"
              disabled={pending}
              onClick={() => void read()}
            >
              {pending ? t("feed.opening") : opened ? t("feed.continue") : readLabel}
              <Icon name="arrow" size={16} />
            </button>
            <a href={short.original_url} target="_blank" rel="noreferrer" className="btn h-11 border border-white/30 text-white hover:bg-white/10">
              {t("feed.original")} ↗
            </a>
          </div>
          <a href={short.original_url} target="_blank" rel="noreferrer" className="text-xs leading-relaxed text-white/60 hover:text-white hover:underline">
            {t("feed.short.from", { title: short.original_title, source: short.source_name, license: short.license })}
          </a>
        </Page>
      </div>

      {/* Over every page */}
      <div className="pointer-events-none absolute inset-x-0 top-0 flex items-center justify-between px-5 pt-4 text-xs text-white/70">
        <span className="tabular-nums">{t("feed.short.position", { i: position, n: total })}</span>
        {page > 0 && <span className="max-w-[60%] truncate">{short.title}</span>}
      </div>

      {page === 0 && (
        <div className="absolute bottom-28 right-3 flex flex-col items-center gap-4">
          {rail.map((r) => {
            const inner = (
              <>
                <span className="grid h-12 w-12 place-items-center rounded-full bg-black/25 backdrop-blur transition-colors group-hover:bg-black/40">
                  <Icon name={r.icon} size={20} />
                </span>
                <span className="text-[11px] font-medium text-white/85">{r.label}</span>
              </>
            );
            return r.href ? (
              <a key={r.label} href={r.href} target="_blank" rel="noreferrer" className="group flex flex-col items-center gap-1">
                {inner}
              </a>
            ) : (
              <button key={r.label} type="button" disabled={r.busy} onClick={r.onClick} className="group flex flex-col items-center gap-1">
                {inner}
              </button>
            );
          })}
        </div>
      )}

      <button
        type="button"
        onClick={() => show(page - 1)}
        className={`absolute left-2 top-[38%] hidden h-10 w-10 -translate-y-1/2 place-items-center rounded-full bg-black/25 backdrop-blur hover:bg-black/40 sm:grid ${page === 0 ? "sm:hidden" : ""}`}
        aria-label={t("feed.short.pagePrev")}
      >
        <Icon name="back" size={18} />
      </button>
      <button
        type="button"
        onClick={() => show(page + 1)}
        className={`absolute right-2 top-[38%] hidden h-10 w-10 -translate-y-1/2 place-items-center rounded-full bg-black/25 backdrop-blur hover:bg-black/40 sm:grid ${page === pages - 1 ? "sm:hidden" : ""}`}
        aria-label={t("feed.short.pageNext")}
      >
        <Icon name="next" size={18} />
      </button>

      <div className="absolute inset-x-0 bottom-0 flex flex-col items-center gap-3 bg-gradient-to-t from-black/35 to-transparent pb-4 pt-8">
        <button
          type="button"
          onClick={onNext}
          className="grid h-11 w-11 place-items-center rounded-full bg-black/30 backdrop-blur hover:bg-black/45"
          aria-label={t("feed.short.next")}
        >
          <Icon name="down" size={20} />
        </button>
        <div className="flex gap-1.5">
          {Array.from({ length: pages }, (_, i) => (
            <button
              key={i}
              type="button"
              onClick={() => show(i)}
              aria-label={t("feed.short.page", { i: i + 1 })}
              aria-current={i === page}
              className={`h-1.5 rounded-full transition-all ${i === page ? "w-5 bg-white" : "w-1.5 bg-white/45"}`}
            />
          ))}
        </div>
      </div>
    </section>
  );
}

function Page({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full w-full shrink-0 snap-start flex-col justify-center gap-5 overflow-y-auto px-6 pb-28 pt-14 [scrollbar-width:none] sm:px-14">
      {children}
    </div>
  );
}

function ArticleList({ topic }: { topic: Topic | null }) {
  const t = useT();
  const feed = useFeed(topic);
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
          {t(topic ? "feed.empty" : "feed.emptyAll")}
        </p>
      ) : (
        <>
          <ul className="flex flex-col gap-4">
            {articles.map((a) => (
              <li key={a.id}>
                <ArticleItem article={a} />
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

function ArticleItem({ article }: { article: ArticleCard }) {
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
          <span className="text-xs text-muted">{article.topics.map((x) => t(topicLabel(x))).join(" · ")}</span>
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

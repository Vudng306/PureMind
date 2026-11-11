"use client";

import { useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { AiConsentDialog } from "@/components/ai-consent-dialog";
import { useAuth } from "@/components/auth-provider";
import { Icon, type IconName } from "@/components/icons";
import { Alert, Spinner } from "@/components/ui";
import { progressOf } from "@/lib/doc-view";
import { useDocuments } from "@/lib/documents";
import {
  readingKey,
  readingMinutes,
  resumeAt,
  saveShortProgress,
  setShortInterest,
  shortCards,
  shortMinutes,
  translateShort,
  useRead,
  useReadingShorts,
  useSave,
  useShort,
  useShorts,
  type ShortCard,
  type ShortText,
  type Topic,
} from "@/lib/feed";
import { useLang, useT, type Key } from "@/lib/i18n";
import { MSG } from "@/lib/messages";
import { useAccount } from "@/lib/queries";
import { useSignIn } from "@/lib/sign-in";
import { useUi } from "@/lib/ui-store";

/** A card counts as read after this long, so one passed on the way to another does not move the reader's place. */
const DWELL_MS = 1500;
const PLACE_KEY = "puremind-feed-at";
const UNDO_MS = 8000;

// Each topic's colours for the opening card: deep enough for white text in either theme.
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
  return `radial-gradient(90% 70% at ${x}% 0%, ${light} 0%, transparent 75%), linear-gradient(170deg, ${light} -20%, ${dark} 85%)`;
}

const topicLabel = (topic: Topic) => `feed.topic.${topic}` as Key;

function glide(): ScrollBehavior {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
}

function readPlace(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function keepPlace(key: string, id: string) {
  try {
    localStorage.setItem(key, id);
  } catch {
    // Private window: the place is simply not remembered.
  }
}

/** The feed's quick reads, one article at a time: sideways through its cards, up and down between articles. Both
 * are the browser's own scrolling, so a swipe goes one way only and the position always matches what shows. */
export function FeedViewer({
  topic,
  onTopics,
  onAll,
}: {
  topic: Topic | null;
  onTopics: () => void;
  onAll: () => void;
}) {
  const t = useT();
  const qc = useQueryClient();
  const uiLang = useLang();
  const { showToast } = useUi();
  const feed = useShorts(topic, topic ? "following" : "for_you");
  const { session } = useAuth();
  const signIn = useSignIn();
  const box = useRef<HTMLDivElement>(null);
  const placeKey = `${PLACE_KEY}:${topic ?? "for_you"}`;

  // Where to open: a shared link, else where this reader was.
  const [linked] = useState(() => new URLSearchParams(window.location.search).get("short"));
  const [asked] = useState(() => linked ?? readPlace(placeKey));
  const loaded = feed.data?.pages.flatMap((p) => p.shorts);
  const single = useShort(loaded && asked && !loaded.some((s) => s.id === asked) ? asked : null);

  const [placed, setPlaced] = useState(false);
  const [goTo, setGoTo] = useState<string | null>(null);
  const [pinned, setPinned] = useState<ShortCard[]>([]);
  const [hidden, setHidden] = useState<string[]>([]);
  const [undo, setUndo] = useState<ShortCard | null>(null);
  const [index, setIndex] = useState(0);

  const list = useMemo(() => {
    const first = new Set(pinned.map((s) => s.id));
    return [...pinned, ...(loaded ?? []).filter((s) => !first.has(s.id))].filter((s) => !hidden.includes(s.id));
  }, [pinned, loaded, hidden]);
  const current = list[index] as ShortCard | undefined;
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = feed;

  // Open where asked, or on the first one not finished yet.
  useEffect(() => {
    if (placed || !loaded) return;
    const firstUnread = (loaded.find((s) => !s.completed) ?? loaded[0])?.id ?? null;
    if (asked && !loaded.some((s) => s.id === asked)) {
      if (single.isLoading) return;
      if (single.data) {
        setPinned([single.data]);
        setGoTo(single.data.id);
      } else {
        if (linked) showToast(t("feed.short.unavailable"));
        setGoTo(firstUnread);
      }
    } else setGoTo(asked ?? firstUnread);
    setPlaced(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `t` and `showToast` do not decide where to open
  }, [placed, loaded, asked, linked, single.isLoading, single.data]);

  useLayoutEffect(() => {
    const el = box.current;
    const at = goTo ? list.findIndex((s) => s.id === goTo) : -1;
    if (!el || at < 0) return;
    el.scrollTop = at * el.clientHeight;
    setIndex(at);
    setGoTo(null);
  }, [goTo, list]);

  useEffect(() => {
    if (hasNextPage && !isFetchingNextPage && index >= list.length - 3) void fetchNextPage();
  }, [index, list.length, hasNextPage, isFetchingNextPage, fetchNextPage]);

  const currentId = current?.id;
  useEffect(() => {
    if (!placed || goTo || !currentId) return;
    keepPlace(placeKey, currentId);
    // The link has done its work: a reload now means where the reader has got to.
    if (linked) window.history.replaceState(null, "", window.location.pathname);
  }, [placed, goTo, currentId, placeKey, linked]);

  useEffect(() => {
    if (!undo) return;
    const timer = setTimeout(() => setUndo(null), UNDO_MS);
    return () => clearTimeout(timer);
  }, [undo]);

  const onScroll = useCallback(() => {
    const el = box.current;
    if (el) setIndex(Math.round(el.scrollTop / el.clientHeight));
  }, []);

  // From where the scroll stands, not the state: a key pressed mid-glide still moves one article on from what shows.
  function go(step: number) {
    const el = box.current;
    if (el) el.scrollTo({ top: (Math.round(el.scrollTop / el.clientHeight) + step) * el.clientHeight, behavior: glide() });
  }

  function open(short: ShortCard) {
    if (!list.some((s) => s.id === short.id)) setPinned((p) => [short, ...p]);
    setGoTo(short.id);
  }

  async function hide(short: ShortCard) {
    if (!session) return signIn(); // what a visitor would rather not see is not kept for them
    setHidden((h) => [...h, short.id]);
    setUndo(short);
    try {
      await setShortInterest(short.id, false);
      void qc.invalidateQueries({ queryKey: readingKey });
    } catch (err) {
      setHidden((h) => h.filter((id) => id !== short.id));
      setUndo(null);
      showToast(err instanceof Error ? err.message : MSG["MSG-99"]);
    }
  }

  async function takeBack(short: ShortCard) {
    setUndo(null);
    setHidden((h) => h.filter((id) => id !== short.id));
    try {
      await setShortInterest(short.id, true);
      void qc.invalidateQueries({ queryKey: readingKey });
    } catch (err) {
      showToast(err instanceof Error ? err.message : MSG["MSG-99"]);
    }
  }

  function onKey(e: React.KeyboardEvent) {
    const el = box.current;
    const section = el?.children[Math.round(el.scrollTop / Math.max(el.clientHeight, 1))];
    const pager = section?.querySelector<HTMLElement>("[data-pager]");
    const page = pager?.children[Math.round(pager.scrollLeft / Math.max(pager.clientWidth, 1))] as HTMLElement | undefined;
    // A card taller than the screen reads to its end before the keys move on.
    const scrollable = page?.querySelector<HTMLElement>("[data-card-text]") ?? page;
    const within = (down: boolean) =>
      scrollable && (down ? scrollable.scrollTop + scrollable.clientHeight < scrollable.scrollHeight - 1 : scrollable.scrollTop > 0);
    const moves: Record<string, () => void> = {
      ArrowDown: () => (within(true) ? scrollable?.scrollBy({ top: 80 }) : go(1)),
      ArrowUp: () => (within(false) ? scrollable?.scrollBy({ top: -80 }) : go(-1)),
      ArrowRight: () => pager?.scrollBy({ left: pager.clientWidth, behavior: glide() }),
      ArrowLeft: () => pager?.scrollBy({ left: -pager.clientWidth, behavior: glide() }),
    };
    if (moves[e.key]) {
      e.preventDefault();
      moves[e.key]();
    }
  }

  const translation = useCardLanguage(current, uiLang);

  if (feed.isError)
    return (
      <div className="flex flex-col items-start gap-3">
        <Alert>{feed.error instanceof Error ? feed.error.message : MSG["MSG-99"]}</Alert>
        <button type="button" className="btn-outline" onClick={() => feed.refetch()}>
          {t("common.retry")}
        </button>
      </div>
    );

  return (
    // A tall card on a phone; on a wide screen a wide stage, with what can be done with it in a column beside it.
    <div className="mx-auto w-full max-w-[1240px] lg:grid lg:grid-cols-[minmax(0,1fr)_200px] lg:gap-6 xl:grid-cols-[minmax(0,1fr)_232px]">
      <div className="relative mx-auto flex w-full min-w-0 max-w-[560px] flex-col gap-2 lg:max-w-none">
        {undo && (
          <div role="status" className="absolute left-1/2 top-3 z-10 flex -translate-x-1/2 items-center gap-3 whitespace-nowrap rounded-full bg-menu px-4 py-2 text-sm text-menu-fg shadow-float">
            {t("feed.short.hidden")}
            <button type="button" className="font-semibold underline underline-offset-2" onClick={() => void takeBack(undo)}>
              {t("feed.short.undo")}
            </button>
          </div>
        )}
        {!placed || feed.isPending ? (
          <CardSkeleton />
        ) : list.length === 0 && !hasNextPage ? (
          <div className="feed-card rounded-[20px] border border-dashed border-field">
            <FeedEnd message={t("feed.short.empty")} onTopics={onTopics} onAll={onAll} />
          </div>
        ) : (
          <div
            ref={box}
            onScroll={onScroll}
            onKeyDown={onKey}
            tabIndex={0}
            aria-label={t("feed.mode.shorts")}
            className="feed-card snap-y snap-mandatory overflow-y-auto rounded-[22px] bg-surface shadow-raised [scrollbar-width:none] focus-visible:outline-offset-2 sm:rounded-[28px]"
          >
            {list.map((s, i) => (
              <ShortSlide
                key={s.id}
                short={s}
                active={i === index}
                language={translation.languageOf(s)}
                onLanguage={translation.choose}
                translating={translation.writing === s.id}
                failure={translation.failed?.id === s.id ? translation.failed.message : null}
                onRetry={translation.retry}
                text={translation.textOf(s)}
                upNext={list[i + 1] ? translation.textOf(list[i + 1]).title : null}
                onArticle={go}
                onHide={() => void hide(s)}
              />
            ))}
            <section className="h-full snap-start snap-always border border-line">
              {hasNextPage ? (
                <div className="grid h-full place-items-center">
                  <Spinner />
                </div>
              ) : (
                <FeedEnd message={t("feed.short.end")} onTopics={onTopics} onAll={onAll} />
              )}
            </section>
          </div>
        )}
      </div>

      <aside className="hidden min-w-0 flex-col justify-center gap-6 lg:flex" aria-label={t("feed.rail.aria")}>
        {placed && current && <ShortActions key={current.id} short={current} variant="rail" onHide={() => void hide(current)} />}
        {placed && list.length > 0 && (
          <div className="flex gap-2" role="group" aria-label={t("feed.mode.shorts")}>
            <button type="button" className="round-btn" disabled={index === 0} onClick={() => go(-1)} aria-label={t("feed.short.prev")} title={t("feed.short.prev")}>
              <Icon name="up" size={20} />
            </button>
            <button type="button" className="round-btn" disabled={index >= list.length} onClick={() => go(1)} aria-label={t("feed.short.next")} title={t("feed.short.next")}>
              <Icon name="down" size={20} />
            </button>
          </div>
        )}
        {session && <KeepReading current={current?.id} onOpen={open} />}
      </aside>

      <AiConsentDialog
        open={translation.asking}
        what={t("feed.short.translateWhat")}
        onAgreed={translation.agreed}
        onCancel={translation.cancel}
      />
    </div>
  );
}

/** Which language the cards show. Vietnamese is what they are written in; the English of one is written when the
 * reader first asks for it and then kept, and they stay on their card while it comes. */
function useCardLanguage(current: ShortCard | undefined, uiLang: "vi" | "en") {
  const { data: user } = useAccount();
  const { session } = useAuth();
  const signIn = useSignIn();
  const consented = Boolean(user?.reading_preferences.ai_consent);
  const [wanted, setWanted] = useState<"vi" | "en">(uiLang);
  // An English interface shows English where it exists; only pressing EN spends anything.
  const [pressed, setPressed] = useState(false);
  const [written, setWritten] = useState<Record<string, ShortText>>({});
  const [writing, setWriting] = useState<string | null>(null);
  const [failed, setFailed] = useState<{ id: string; message: string } | null>(null);
  const [asking, setAsking] = useState(false);
  const [attempt, setAttempt] = useState(0);

  const english = useCallback((s: ShortCard) => s.en ?? written[s.id] ?? null, [written]);
  const needed = wanted === "en" && pressed && current && !english(current) ? current.id : null;

  useEffect(() => {
    if (!needed) return;
    if (!user) return;
    if (!consented) {
      setAsking(true);
      return;
    }
    let live = true;
    setWriting(needed);
    setFailed(null);
    translateShort(needed)
      .then((text) => setWritten((w) => ({ ...w, [needed]: text })))
      .catch((err) => {
        if (live) setFailed({ id: needed, message: err instanceof Error ? err.message : MSG["MSG-26"] });
      })
      .finally(() => {
        if (live) setWriting(null);
      });
    return () => {
      live = false;
      setWriting(null);
    };
  }, [needed, user, consented, attempt]);

  return {
    writing,
    failed,
    asking,
    textOf: (s: ShortCard): ShortText => (wanted === "en" && english(s)) || s,
    languageOf: (s: ShortCard): "vi" | "en" => (wanted === "en" && english(s) ? "en" : "vi"),
    choose: (language: "vi" | "en") => {
      // Writing an English one asks the AI, which takes an account; one already written is anyone's to read.
      if (language === "en" && !session && current && !english(current)) return signIn();
      setWanted(language);
      setPressed(language === "en");
      setFailed(null);
    },
    retry: () => setAttempt((n) => n + 1),
    agreed: () => setAsking(false),
    cancel: () => {
      setAsking(false);
      setWanted("vi");
      setPressed(false);
    },
  };
}

// A figure and the unit after it: "30 phút", "2,54%", "1971". Not the digits inside a name such as "omega-3" or "B12".
const FIGURE =
  /((?<![\p{L}\-\d])\d+(?:[.,]\d+)*(?:\s?%|\s(?:phút|giờ|giây|ngày|tuần|tháng|năm|tuổi|lần|người|đồng|nghìn|triệu|tỷ|kg|mg|ml|lít|km|kcal|bước|min|minutes|hours|days|weeks|months|years|times|people)(?![\p{L}]))?)/u;

/** The text with its figures lifted out, so a reader skimming the card still catches them. Only how it looks changes. */
function withFigures(text: string) {
  return text.split(FIGURE).map((part, i) =>
    i % 2 ? (
      <mark key={i} className="rounded-[6px] bg-white/15 px-1 font-semibold text-white [box-decoration-break:clone]">
        {part}
      </mark>
    ) : (
      part
    ),
  );
}

/** What the article is: its topic, how long it takes, and that the AI wrote it. */
function ShortMeta({ short, text, language }: { short: ShortCard; text: ShortText; language: "vi" | "en" }) {
  const t = useT();
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-white/75">
      {short.topics[0] && (
        <span className="min-w-0 truncate rounded-full bg-white/15 px-2.5 py-1 font-semibold text-white">{t(topicLabel(short.topics[0]))}</span>
      )}
      <span className="shrink-0 tabular-nums">{t("feed.short.minutes", { n: shortMinutes(text) })}</span>
      <span className="inline-flex shrink-0 items-center gap-1 font-medium">
        <Icon name="spark" size={12} />
        {t(language === "en" ? "feed.short.aiTranslated" : "feed.short.ai")}
      </span>
    </div>
  );
}

/** One article: a cover with its title, and its cards to turn. On a phone the cover is the first card; on a wide
 * screen it stays on the left while the cards turn on the right. */
function ShortSlide({
  short,
  active,
  language,
  onLanguage,
  translating,
  failure,
  onRetry,
  text,
  upNext,
  onArticle,
  onHide,
}: {
  short: ShortCard;
  active: boolean;
  language: "vi" | "en";
  onLanguage: (language: "vi" | "en") => void;
  translating: boolean;
  failure: string | null;
  onRetry: () => void;
  text: ShortText;
  upNext: string | null;
  onArticle: (step: number) => void;
  onHide: () => void;
}) {
  const t = useT();
  const qc = useQueryClient();
  const cards = shortCards(text);
  const n = cards.length;
  const pager = useRef<HTMLDivElement>(null);
  const [page, setPage] = useState(0);
  const saved = useRef(short.card_index);
  const signedIn = Boolean(useAuth().session); // a visitor's place in it is not kept

  // Back where they stopped: this card, not the first.
  useLayoutEffect(() => {
    const el = pager.current;
    const at = resumeAt(short);
    if (el && at > 0) {
      el.scrollLeft = at * el.clientWidth;
      setPage(at);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only when it first shows; afterwards the reader moves it
  }, []);

  useEffect(() => {
    if (!signedIn || !active || page === saved.current || (page === 0 && saved.current === 0)) return;
    const timer = setTimeout(() => {
      const before = saved.current;
      saved.current = page;
      saveShortProgress(short.id, page)
        .then(() => qc.invalidateQueries({ queryKey: readingKey }))
        .catch(() => {
          saved.current = before; // tried again the next time they turn a card
        });
    }, DWELL_MS);
    return () => clearTimeout(timer);
  }, [signedIn, active, page, short.id, qc]);

  function show(i: number) {
    pager.current?.scrollTo({ left: i * pager.current.clientWidth, behavior: glide() });
  }

  function turn(step: number) {
    const el = pager.current;
    if (el) show(Math.round(el.scrollLeft / el.clientWidth) + step);
  }

  const last = page === n - 1;
  const source = (
    <a
      href={short.original_url}
      target="_blank"
      rel="noreferrer"
      title={short.original_title}
      className="block truncate text-xs text-white/65 hover:text-white hover:underline"
    >
      {t("feed.short.source", { source: short.source_name, title: short.original_title })} ↗
    </a>
  );

  return (
    <section
      className="relative flex h-full snap-start snap-always text-white"
      style={{ background: backdrop(short.topics[0], short.id) }}
      aria-label={text.title}
      inert={!active}
    >
      <div className="hidden w-[42%] shrink-0 flex-col gap-6 p-9 lg:flex xl:p-11">
        <ShortMeta short={short} text={text} language={language} />
        <h2 className="mt-auto font-display text-[36px] font-semibold leading-[1.08] [text-wrap:balance] xl:text-[46px]">{text.title}</h2>
        {source}
      </div>

      <div className="flex min-w-0 flex-1 flex-col lg:my-4 lg:mr-4 lg:rounded-[22px] lg:border lg:border-white/10 lg:bg-black/25 lg:backdrop-blur-sm">
        <header className="flex items-center gap-2 px-5 pt-4 lg:px-7 lg:pt-5">
          <div className="min-w-0 flex-1">
            <div className="lg:hidden">
              <ShortMeta short={short} text={text} language={language} />
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-0.5 rounded-full bg-white/10 p-0.5" role="group" aria-label={t("feed.short.language")}>
            {(["vi", "en"] as const).map((l) => (
              <button
                key={l}
                type="button"
                aria-pressed={language === l}
                onClick={() => onLanguage(l)}
                className={`relative h-7 min-w-11 rounded-full px-2.5 text-xs font-semibold before:absolute before:-inset-y-2 before:inset-x-0 sm:min-w-0 ${
                  language === l ? "bg-white text-[#141414]" : "text-white/75 hover:text-white"
                }`}
              >
                {l.toUpperCase()}
              </button>
            ))}
          </div>
        </header>

        {(translating || failure) && (
          <div role="status" className="flex items-center gap-2 px-5 pt-2 text-xs text-white/80 lg:px-7">
            {translating ? (
              <>
                <span aria-hidden className="h-1 w-10 animate-pulse rounded-full bg-white/50 motion-reduce:animate-none" />
                {t("feed.short.translating")}
              </>
            ) : (
              <>
                <span className="min-w-0 flex-1">{failure}</span>
                <button type="button" className="shrink-0 font-semibold underline underline-offset-2" onClick={onRetry}>
                  {t("common.retry")}
                </button>
              </>
            )}
          </div>
        )}

        <div
          ref={pager}
          data-pager
          onScroll={(e) => setPage(Math.round(e.currentTarget.scrollLeft / e.currentTarget.clientWidth))}
          className="flex min-h-0 flex-1 snap-x snap-mandatory overflow-x-auto [scrollbar-width:none]"
        >
          {cards.map((card, i) => (
            <div
              key={i}
              inert={i !== page}
              className={`flex h-full w-full shrink-0 snap-start snap-always flex-col px-5 py-4 lg:px-9 lg:py-6 ${card.role === "hook" ? "max-lg:pr-[76px]" : ""}`}
            >
              <div data-card-text className="safe-center flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto [scrollbar-width:thin]">
                {card.role === "hook" ? (
                  <div className="flex flex-col gap-5">
                    <h2 className="font-display text-[32px] font-semibold leading-[1.1] [text-wrap:balance] lg:hidden">{card.title}</h2>
                    <p className="text-[17px] leading-[1.6] text-white/90 lg:font-serif lg:text-[25px] lg:leading-[1.5] lg:text-white">{withFigures(card.body)}</p>
                  </div>
                ) : card.role === "insight" ? (
                  <div className="flex flex-col gap-3 rounded-[18px] border border-white/10 border-l-[3px] border-l-accent bg-white/10 p-5 backdrop-blur-sm lg:p-7">
                    <p className="inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-[0.08em] text-white/75">
                      <Icon name="spark" size={13} />
                      {t("feed.short.insight", { i: card.point ?? 1 })}
                    </p>
                    <p className="font-serif text-[21px] leading-[1.45] lg:text-[26px]">{withFigures(card.body)}</p>
                  </div>
                ) : (
                  <div className="flex flex-col gap-5">
                    <p className="text-xs font-semibold uppercase tracking-[0.08em] text-white/75">{t("feed.short.keep")}</p>
                    <p className="font-serif text-[21px] leading-[1.42] lg:text-[26px]">{withFigures(card.body)}</p>
                    <LastCardActions short={short} />
                    {upNext && (
                      <button
                        type="button"
                        onClick={() => onArticle(1)}
                        className="group flex items-center gap-3 rounded-[16px] border border-white/10 bg-white/10 p-3.5 text-left transition-colors hover:bg-white/15"
                      >
                        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                          <span className="text-xs font-semibold uppercase tracking-[0.08em] text-white/60">{t("feed.short.upNext")}</span>
                          <span className="line-clamp-2 font-medium leading-snug">{upNext}</span>
                        </span>
                        <Icon name="down" size={18} />
                      </button>
                    )}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>

        <footer className="flex flex-col gap-2 px-5 pb-4 lg:px-7 lg:pb-5">
          <div className="lg:hidden">{source}</div>
          <div className="flex items-center gap-3">
            <div className="flex flex-1 items-center gap-1.5" role="group" aria-label={t("feed.short.card", { i: page + 1, n })}>
              {cards.map((_, i) => (
                <button
                  key={i}
                  type="button"
                  onClick={() => show(i)}
                  aria-label={t("feed.short.cardN", { i: i + 1 })}
                  aria-current={i === page}
                  className="flex h-6 items-center"
                >
                  <span
                    className={`block h-2 rounded-full transition-all motion-reduce:transition-none ${
                      i === page ? "w-6 bg-white" : i < page ? "w-2 bg-white/60" : "w-2 bg-white/30"
                    }`}
                  />
                </button>
              ))}
            </div>
            {active && (
              <span className="sr-only" aria-live="polite">
                {t("feed.short.card", { i: page + 1, n })}
              </span>
            )}
            <button
              type="button"
              className="round-btn-glass"
              disabled={page === 0}
              onClick={() => turn(-1)}
              aria-label={t("feed.short.prevCardAria")}
            >
              <Icon name="back" size={18} />
            </button>
            <button
              type="button"
              className="round-btn-glass bg-white text-[#141414] hover:bg-white/90"
              onClick={() => (last ? onArticle(1) : turn(1))}
              aria-label={t(last ? "feed.short.next" : "feed.short.nextCardAria")}
            >
              <Icon name={last ? "down" : "next"} size={18} />
            </button>
          </div>
        </footer>
      </div>

      {active && page === 0 && (
        <div className="absolute bottom-[92px] right-3 lg:hidden">
          <ShortActions short={short} variant="float" onHide={onHide} />
        </div>
      )}
    </section>
  );
}

/** Reading on, where the last card ends. It asks nothing of the reader: the next article is still one move away. */
function LastCardActions({ short }: { short: ShortCard }) {
  const t = useT();
  const { read, opened, pending, error } = useRead(short.read_id, short.document_id);
  const { save, saved, saving } = useSave(short.read_id, short.document_id);
  const minutes = readingMinutes(short.read_words);
  const glass = "btn h-11 border border-white/15 bg-white/10 px-2 text-sm text-white hover:bg-white/20";
  return (
    <div className="flex flex-col gap-2">
      {error && <Alert>{error}</Alert>}
      <button type="button" className="btn-primary h-11" disabled={pending} onClick={() => void read()}>
        {pending
          ? t("feed.opening")
          : opened
            ? t("feed.continue")
            : t(short.read_kind === "guide" ? "feed.short.readGuide" : "feed.short.readOn", { n: minutes })}
        <Icon name="arrow" size={16} />
      </button>
      <div className="grid grid-cols-2 gap-2">
        <button type="button" className={glass} disabled={saving || saved} aria-pressed={saved} onClick={() => void save()}>
          <Icon name={saved ? "check" : "bookmark"} size={16} />
          {t(saved ? "feed.savedShort" : "feed.short.saveLibrary")}
        </button>
        <button type="button" className={glass} disabled={pending} onClick={() => void read("?panel=chat")}>
          <Icon name="spark" size={16} />
          {t("feed.short.askAi")}
        </button>
      </div>
      <p className="text-xs leading-relaxed text-white/65">
        <a href={short.license_url || short.original_url} target="_blank" rel="noreferrer" className="hover:text-white hover:underline">
          {t("feed.short.from", { title: short.original_title, source: short.source_name, license: short.license })}
        </a>
      </p>
    </div>
  );
}

/** What can be done with the article on show: round buttons over the cover on a phone, a column beside the stage on
 * a wide screen. */
function ShortActions({ short, variant, onHide }: { short: ShortCard; variant: "rail" | "float"; onHide: () => void }) {
  const t = useT();
  const { showToast } = useUi();
  const { read, opened, pending, error } = useRead(short.read_id, short.document_id);
  const { save, saved, saving } = useSave(short.read_id, short.document_id);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (error) showToast(error); // e.g. the article was taken down: say so, and stay here
  }, [error, showToast]);

  async function share() {
    const url = `${window.location.origin}/feed?short=${short.id}`;
    try {
      if (navigator.share) return await navigator.share({ title: short.title, url });
      await navigator.clipboard.writeText(`${short.title}\n${url}`);
      setCopied(true);
      showToast(t("feed.short.copied"));
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // The reader closed the share sheet.
    }
  }

  const actions: { key: string; icon: IconName; label: string; onClick: () => void; disabled?: boolean; pressed?: boolean }[] = [
    {
      key: "read",
      icon: "file",
      label: pending ? t("feed.opening") : opened ? t("feed.continue") : t(short.read_kind === "guide" ? "feed.short.readGuideShort" : "feed.short.readShort"),
      onClick: () => void read(),
      disabled: pending,
    },
    {
      key: "save",
      icon: saved ? "check" : "bookmark",
      label: t(saved ? "feed.savedShort" : "feed.save"),
      onClick: () => void save(),
      disabled: saving || saved,
      pressed: saved,
    },
    { key: "ask", icon: "spark", label: t("feed.short.askAi"), onClick: () => void read("?panel=chat"), disabled: pending },
    { key: "share", icon: copied ? "check" : "upload", label: t("feed.short.share"), onClick: () => void share() },
    { key: "hide", icon: "x", label: t("feed.short.notInterested"), onClick: onHide },
  ];

  if (variant === "float")
    // Reading the original waits on the last card; over the cover there is room for four.
    return (
      <div className="flex flex-col items-center gap-3">
        {actions
          .filter((a) => a.key !== "read")
          .map((a) => (
            <button
              key={a.key}
              type="button"
              disabled={a.disabled}
              aria-pressed={a.pressed}
              onClick={a.onClick}
              className="flex w-14 flex-col items-center gap-1 text-center text-[11px] font-medium leading-[1.15] text-white"
            >
              <span className="grid h-11 w-11 place-items-center rounded-full border border-white/15 bg-black/30 backdrop-blur-sm transition-colors hover:bg-black/40">
                <Icon name={a.icon} size={19} />
              </span>
              <span className="line-clamp-2 [text-shadow:0_1px_2px_rgb(0_0_0/0.4)]">{a.label}</span>
            </button>
          ))}
      </div>
    );

  return (
    <div className="flex flex-col gap-2.5">
      {actions.map((a, i) => (
        <button
          key={a.key}
          type="button"
          disabled={a.disabled}
          aria-pressed={a.pressed}
          onClick={a.onClick}
          className={`group flex items-center gap-3 text-left text-sm font-medium disabled:cursor-not-allowed ${i === 4 ? "text-muted" : "text-ink"}`}
        >
          <span
            className={`grid h-11 w-11 shrink-0 place-items-center rounded-full transition-colors ${
              i === 0
                ? "bg-accent text-on-accent group-hover:bg-accent-hover"
                : "border border-line bg-surface shadow-card group-hover:bg-soft"
            } ${a.disabled && !a.pressed ? "opacity-60" : ""}`}
          >
            <Icon name={a.icon} size={18} />
          </span>
          <span className="min-w-0 group-hover:underline group-hover:underline-offset-4">{a.label}</span>
        </button>
      ))}
    </div>
  );
}

/** What the reader left partway: quick reads first, then what they are reading in the library. At most three, and
 * nothing at all when there is nothing to pick up. */
function KeepReading({ current, onOpen }: { current: string | undefined; onOpen: (short: ShortCard) => void }) {
  const t = useT();
  const shorts = useReadingShorts();
  const docs = useDocuments("created_desc");
  const open = (shorts.data ?? []).filter((s) => s.id !== current).slice(0, 3);
  const reading = (docs.data ?? [])
    .filter((d) => {
      const pct = progressOf(d);
      return pct > 0 && pct < 100;
    })
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
    .slice(0, Math.max(0, 3 - open.length));
  if (!open.length && !reading.length) return null;

  return (
    <section className="flex flex-col gap-2.5 border-t border-line pt-4">
      <h2 className="eyebrow uppercase">{t("feed.rail.reading")}</h2>
      <ul className="flex flex-col gap-3">
        {open.map((s) => (
          <li key={s.id}>
            <button type="button" className="group flex w-full flex-col gap-1 text-left" onClick={() => onOpen(s)}>
              <span className="line-clamp-2 text-sm font-medium leading-snug group-hover:underline group-hover:underline-offset-4">{s.title}</span>
              <span className="text-xs tabular-nums text-muted">
                {t("feed.short.position", { i: s.card_index + 1, n: s.total_cards })}
              </span>
            </button>
          </li>
        ))}
        {reading.map((d) => (
          <li key={d.id}>
            <Link href={`/reader/${d.id}`} className="group flex flex-col gap-1">
              <span className="line-clamp-2 text-sm font-medium leading-snug group-hover:underline group-hover:underline-offset-4">{d.title}</span>
              <span className="text-xs tabular-nums text-muted">{progressOf(d)}%</span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

function FeedEnd({ message, onTopics, onAll }: { message: string; onTopics: () => void; onAll: () => void }) {
  const t = useT();
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 px-8 text-center">
      <p className="max-w-sm font-serif text-[22px] leading-snug text-ink">{message}</p>
      <div className="flex flex-col items-stretch gap-2">
        <button type="button" className="btn-primary h-11 px-5" onClick={onTopics}>
          {t("feed.editTopics")}
        </button>
        <Link href="/explore" className="btn-outline h-11 px-5">
          {t("nav.explore")}
        </Link>
        <button type="button" className="btn-ghost h-11 px-5" onClick={onAll}>
          {t("feed.menu.all")}
        </button>
      </div>
    </div>
  );
}

function CardSkeleton() {
  const t = useT();
  return (
    <div role="status" aria-label={t("common.loading")} className="feed-card flex flex-col gap-3 rounded-[20px] border border-line bg-surface p-4 sm:rounded-[24px] sm:p-5">
      <div className="flex animate-pulse flex-col gap-3 motion-reduce:animate-none">
        <div className="h-6 w-1/2 rounded-full bg-soft" />
        <div className="h-1 w-full rounded-full bg-soft" />
      </div>
      <div className="min-h-0 flex-1 animate-pulse rounded-[18px] bg-soft motion-reduce:animate-none" />
      <div className="h-10 animate-pulse rounded-full bg-soft motion-reduce:animate-none" />
    </div>
  );
}

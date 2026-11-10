"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";

import { AiConsentDialog } from "@/components/ai-consent-dialog";
import { Icon } from "@/components/icons";
import { MarkdownView } from "@/components/notebook-markdown";
import { ApiError } from "@/lib/api";
import { MAX_CHAT_QUESTION } from "@/lib/chat";
import { exploreChat, readingMinutes, useRead, useSave, type ArticleCard, type ExploreTurn } from "@/lib/feed";
import { useLang, useT, type Key } from "@/lib/i18n";
import { parseMarkdown } from "@/lib/markdown";
import { MSG } from "@/lib/messages";
import { accountKey, useAccount } from "@/lib/queries";
import type { User } from "@/lib/types";

type Turn = { role: "user"; content: string } | { role: "assistant"; content: string; articles: ArticleCard[]; cited: number[] };

// The conversation stays with the tab: it is not stored anywhere, so leaving the feed and coming back keeps it.
const STORE = "pm.explore-chat";
const STARTERS = ["feedChat.starter1", "feedChat.starter2", "feedChat.starter3", "feedChat.starter4"] as const;

function loadTurns(): Turn[] {
  try {
    const raw = sessionStorage.getItem(STORE);
    const turns = raw ? JSON.parse(raw) : [];
    return Array.isArray(turns) ? turns : [];
  } catch {
    return [];
  }
}

function saveTurns(turns: Turn[]) {
  try {
    if (turns.length) sessionStorage.setItem(STORE, JSON.stringify(turns));
    else sessionStorage.removeItem(STORE);
  } catch {
    // private mode or storage full: the conversation just does not outlive the page
  }
}

/** The feed's chat: the reader says what they want to learn about, the AI explains it briefly and recommends
 * the feed's own articles on it — never one that is not there. */
export function ExploreChat() {
  const t = useT();
  const lang = useLang();
  const qc = useQueryClient();
  const { data: user } = useAccount();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState<string | null>(null); // the message being answered
  const [streamed, setStreamed] = useState("");
  const [found, setFound] = useState<ArticleCard[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);

  const consented = Boolean(user?.reading_preferences.ai_consent);
  const quota = user?.chat_quota_remaining;
  const busy = pending !== null;

  useEffect(() => setTurns(loadTurns()), []);

  useEffect(() => {
    if (turns.length || pending) bottom.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [turns.length, streamed, pending]);

  async function send(text?: string) {
    const content = (text ?? draft).trim();
    if (!content || busy) return;
    if (!consented) {
      setDraft(content);
      return setAsking(true);
    }

    setError(null);
    setPending(content);
    setStreamed("");
    setFound([]);
    setDraft("");
    const history: ExploreTurn[] = turns.map(({ role, content }) => ({ role, content }));
    try {
      const result = await exploreChat(
        { content, history, language: lang },
        { onArticles: setFound, onDelta: (d) => setStreamed((s) => s + d) },
      );
      const next: Turn[] = [
        ...turns,
        { role: "user", content },
        { role: "assistant", content: result.content, articles: result.articles, cited: result.cited },
      ];
      setTurns(next);
      saveTurns(next);
      qc.setQueryData<User>(accountKey, (u) => (u ? { ...u, chat_quota_remaining: result.chat_quota_remaining } : u));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : MSG["MSG-99"]);
      setDraft(content); // given back, unanswered and uncharged
    } finally {
      setPending(null);
      setStreamed("");
    }
  }

  function startOver() {
    if (busy) return;
    setTurns([]);
    saveTurns([]);
    setError(null);
    input.current?.focus();
  }

  return (
    <section className="flex flex-col gap-6" aria-label={t("feed.mode.chat")}>
      {turns.length === 0 && !busy ? (
        <div className="flex flex-col gap-5 pt-2">
          <div className="flex flex-col gap-2">
            <h2 className="font-serif text-[30px] font-medium leading-tight sm:text-[34px]">{t("feedChat.title")}</h2>
            <p className="max-w-2xl text-[15px] leading-relaxed text-muted">{t("feedChat.lede")}</p>
          </div>
          <div className="grid gap-2.5 sm:grid-cols-2">
            {STARTERS.map((key) => (
              <button
                key={key}
                type="button"
                className="card flex items-start gap-3 p-4 text-left text-[15px] leading-snug text-ink transition-colors hover:border-accent"
                onClick={() => void send(t(key))}
              >
                <Icon name="spark" size={16} className="mt-0.5 shrink-0 text-accent-text" />
                {t(key)}
              </button>
            ))}
          </div>
        </div>
      ) : (
        <div className="flex items-center justify-between gap-3">
          <h2 className="font-serif text-[22px] font-medium">{t("feedChat.titleShort")}</h2>
          <button type="button" className="btn-ghost h-9 px-3 text-sm" onClick={startOver} disabled={busy}>
            <Icon name="plus" size={15} />
            {t("chat.newConversation")}
          </button>
        </div>
      )}

      <div className="flex flex-col gap-6">
        {turns.map((turn, i) =>
          turn.role === "user" ? (
            <Said key={i} content={turn.content} />
          ) : (
            <Reply key={i} content={turn.content} articles={turn.articles} cited={turn.cited} />
          ),
        )}
        {pending && (
          <>
            <Said content={pending} />
            {streamed ? (
              <Reply content={streamed} articles={found} cited={null} />
            ) : (
              <div role="status" className="flex items-center gap-2.5 text-sm text-muted">
                <span className="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-line border-t-accent" aria-hidden />
                {t("feedChat.searching")}
              </div>
            )}
          </>
        )}
        <div ref={bottom} />
      </div>

      <div className="sticky bottom-24 z-10 flex flex-col gap-1.5 lg:bottom-4">
        {error && <p className="glass rounded-lg px-3 py-2 text-sm text-danger">{error}</p>}
        <label className="sr-only" htmlFor="explore-message">
          {t("feedChat.inputLabel")}
        </label>
        <div className="glass flex items-end gap-2 rounded-[18px] border border-field px-3 py-2 shadow-lg focus-within:border-focus">
          <textarea
            ref={input}
            id="explore-message"
            value={draft}
            maxLength={MAX_CHAT_QUESTION}
            rows={1}
            placeholder={t(turns.length ? "feedChat.placeholderMore" : "feedChat.placeholder")}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void send();
              }
            }}
            disabled={busy || quota === 0}
            className="max-h-40 min-h-[44px] flex-1 resize-none bg-transparent py-2.5 text-[15px] leading-normal text-ink outline-none placeholder:text-muted [field-sizing:content]"
          />
          <button
            type="button"
            aria-label={t("feedChat.send")}
            onClick={() => void send()}
            disabled={busy || !draft.trim() || quota === 0}
            className="btn-primary mb-1 h-9 w-9 shrink-0 justify-center px-0"
          >
            <Icon name="arrow" size={16} />
          </button>
        </div>
        <span className={`px-1 text-xs ${quota === 0 ? "text-danger" : "text-muted"}`}>
          {quota === 0 ? MSG["MSG-CHAT-QUOTA"] : quota === undefined ? t("chat.enterHint") : t("chat.quotaHint", { n: quota })}
        </span>
      </div>

      <AiConsentDialog
        open={asking}
        what={t("feedChat.consentWhat")}
        onAgreed={() => {
          setAsking(false);
          void send();
        }}
        onCancel={() => setAsking(false)}
      />
    </section>
  );
}

function Said({ content }: { content: string }) {
  return (
    <p className="max-w-[85%] self-end whitespace-pre-wrap rounded-[18px] rounded-br-md bg-accent/10 px-4 py-2.5 text-[15px] leading-relaxed text-ink">
      {content}
    </p>
  );
}

/** An answer, with the articles it recommends under it; `cited` is null while it is still being written. */
function Reply({ content, articles, cited }: { content: string; articles: ArticleCard[]; cited: number[] | null }) {
  const t = useT();
  const blocks = useMemo(() => parseMarkdown(content), [content]);
  const recommended = (cited ?? []).map((n) => articles[n - 1]).filter(Boolean);

  return (
    <div className="flex flex-col gap-3">
      <MarkdownView
        blocks={blocks}
        className="text-[16px] leading-[1.7] text-body"
        renderRef={(n) => {
          const a = articles[n - 1];
          const cls = "mx-px rounded px-1 py-px align-[0.1em] font-sans text-[0.72em] font-semibold";
          if (!a) return <span className={`${cls} bg-soft text-muted`}>{n}</span>;
          return (
            <a href={`#explore-${a.id}`} className={`${cls} bg-accent/15 text-accent-text hover:bg-accent/25`} title={a.title} aria-label={t("feedChat.refAria", { n, title: a.title })}>
              {n}
            </a>
          );
        }}
      />
      {recommended.length > 0 && (
        <div className="flex flex-col gap-2">
          <span className="eyebrow uppercase">{t("feedChat.recommended")}</span>
          <ul className="grid gap-2.5 sm:grid-cols-2">
            {recommended.map((a) => (
              <li key={a.id} id={`explore-${a.id}`} className="scroll-mt-24">
                <Recommendation article={a} n={articles.indexOf(a) + 1} />
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function Recommendation({ article, n }: { article: ArticleCard; n: number }) {
  const t = useT();
  const { read, opened, pending, error } = useRead(article.id, article.document_id);
  const { save, saved, saving } = useSave(article.id, article.document_id);
  const meta = [
    article.source_name,
    article.language !== "vi" ? article.language.toUpperCase() : null,
    t("common.minutesRead", { n: readingMinutes(article.word_count) }),
  ].filter(Boolean);

  return (
    <article className="card flex h-full flex-col gap-2 p-4">
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 flex h-5 min-w-5 shrink-0 items-center justify-center rounded bg-accent/15 px-1 text-[11px] font-semibold text-accent-text">{n}</span>
        <div className="flex min-w-0 flex-col gap-1">
          <h3 className="font-serif text-[17px] font-medium leading-snug">
            <button type="button" className="text-left hover:underline hover:underline-offset-4" onClick={() => void read()}>
              {article.title}
            </button>
          </h3>
          <p className="text-xs text-muted">
            {meta.join(" · ")}
            {article.topics.length > 0 && ` · ${article.topics.map((x) => t(`feed.topic.${x}` as Key)).join(", ")}`}
          </p>
        </div>
      </div>
      {error && <p className="text-sm text-danger">{error}</p>}
      <div className="mt-auto flex flex-wrap items-center gap-1.5 pt-1">
        <button type="button" className={opened ? "btn-dark h-9 px-3.5 text-sm" : "btn-primary h-9 px-3.5 text-sm"} disabled={pending} onClick={() => void read()}>
          {pending ? t("feed.opening") : t(opened ? "feed.continue" : "feed.read")}
          <Icon name="arrow" size={15} />
        </button>
        <button type="button" className="btn-ghost h-9 px-3 text-sm" disabled={saving || saved} aria-pressed={saved} onClick={() => void save()}>
          <Icon name={saved ? "check" : "bookmark"} size={15} />
          {t(saved ? "feed.savedShort" : "feed.saveLater")}
        </button>
      </div>
    </article>
  );
}

"use client";

import Link from "next/link";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { AiConsentDialog } from "@/components/ai-consent-dialog";
import { FigureImage } from "@/components/clean-reader";
import { Icon } from "@/components/icons";
import { MarkdownView } from "@/components/notebook-markdown";
import { api, ApiError } from "@/lib/api";
import { readTranslation, translateArticle } from "@/lib/article-translation";
import { startingLevel, type Article, type QuickRead, type ReadingLevel } from "@/lib/catalog";
import { readingMinutes } from "@/lib/feed";
import { useLang, useT, type Key } from "@/lib/i18n";
import { parseMarkdown } from "@/lib/markdown";
import { MSG } from "@/lib/messages";
import { useAccount } from "@/lib/queries";
import { useUi } from "@/lib/ui-store";

// Below the sticky header: a block reaching no further than this is out of sight.
const TOP_OF_SCREEN = 96;

const REASONS: ["wrong" | "missing" | "other", Key][] = [
  ["wrong", "catalog.reportWrong"],
  ["missing", "catalog.reportMissing"],
  ["other", "catalog.reportOther"],
];

/** Lets a signed-in reader say a Quick Read is wrong, from a fixed list; admins see the counts. */
function ReportQuickRead({ articleId, signedIn }: { articleId: string; signedIn: boolean }) {
  const t = useT();
  const { showToast } = useUi();
  const [open, setOpen] = useState(false);
  const [sent, setSent] = useState(false);
  const [sending, setSending] = useState(false);

  if (!signedIn) {
    return <Link href="/login" className="text-sm font-medium text-muted underline underline-offset-2 hover:text-ink">{t("catalog.reportSignIn")}</Link>;
  }
  if (sent) return <p role="status" className="text-sm text-muted">{t("catalog.reportSent")}</p>;
  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="btn-ghost -ml-3 h-10 self-start px-3 text-sm text-muted">
        {t("catalog.report")}
      </button>
    );
  }

  async function send(reason: string) {
    setSending(true);
    try {
      await api<void>(`/catalog/${articleId}/quick/report`, { method: "POST", body: JSON.stringify({ reason }) });
      setSent(true);
    } catch (e) {
      showToast(e instanceof Error ? e.message : MSG["MSG-99"]);
    } finally {
      setSending(false);
    }
  }

  return (
    <div role="group" aria-label={t("catalog.report")} className="flex flex-wrap items-center gap-2">
      <span className="text-sm text-muted">{t("catalog.reportAsk")}</span>
      {REASONS.map(([reason, label]) => (
        <button key={reason} type="button" className="chip" disabled={sending} onClick={() => void send(reason)}>{t(label)}</button>
      ))}
    </div>
  );
}

/** An article's first level: what it found, in under a minute, marked as the AI's and leading to the original. */
function QuickReading({ article, quick, signedIn, onFull }: { article: Article; quick: QuickRead; signedIn: boolean; onFull: () => void }) {
  const t = useT();
  return (
    <div className="flex flex-col gap-6">
      <p className="inline-flex items-center gap-2 self-start rounded-full bg-accent-soft px-3 py-1 text-xs font-semibold text-accent-text">
        <Icon name="spark" size={14} />{t("catalog.aiMade")}
      </p>
      <header className="flex flex-col gap-3">
        <h1 className="font-display text-[30px] font-semibold leading-tight tracking-[-0.01em] sm:text-[38px]">{quick.title}</h1>
        <p className="text-sm leading-relaxed text-muted"><span className="font-semibold">{t("catalog.originalTitle")}: </span><i>{article.title}</i></p>
      </header>
      <p className="font-serif text-xl leading-relaxed text-body">{quick.problem}</p>
      <ol className="flex flex-col gap-4">
        {quick.points.map((point, i) => (
          <li key={point} className="flex gap-3.5 text-[17px] leading-relaxed text-body">
            <span aria-hidden className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-soft text-sm font-semibold text-ink">{i + 1}</span>
            <span>{point}</span>
          </li>
        ))}
      </ol>
      <div className="rounded-xl bg-soft p-4 sm:p-5">
        <p className="mb-1 text-xs font-semibold uppercase tracking-[0.06em] text-muted">{t("catalog.conclusion")}</p>
        <p className="text-[17px] font-medium leading-relaxed text-ink">{quick.conclusion}</p>
      </div>
      {!quick.results_complete && <p className="rounded-xl border border-line p-4 text-sm leading-relaxed">{t("catalog.resultsIncomplete")}</p>}
      <button type="button" onClick={onFull} className="btn-primary h-12 self-start px-5">
        {t("catalog.readOriginal", { n: readingMinutes(article.word_count ?? 0) })}
      </button>
      <div className="flex flex-col gap-2 border-t border-line pt-5">
        <p className="text-sm leading-relaxed text-muted">{t("catalog.aiCredit", { authors: article.authors, source: article.source })}</p>
        <ReportQuickRead articleId={article.id} signedIn={signedIn} />
      </div>
    </div>
  );
}

/** A chart of the article, from the publisher's site. The source's text is trusted here, unlike a model's. */
export function articleFigure(src: string, alt: string) {
  return (
    <figure className="mb-6">
      <FigureImage documentId="" src={src} alt={alt} />
      {alt && <figcaption className="mt-2 text-center font-sans text-sm leading-normal text-muted">{alt}</figcaption>}
    </figure>
  );
}

/** Getting an article's Vietnamese when it is wanted: one that exists costs nothing and needs no account. Writing
 * one sends the text to OpenAI, so it takes a signed-in reader who has agreed to that. */
function useTranslation(article: Article, wanted: boolean, signedIn: boolean) {
  const { data: user } = useAccount();
  const [status, setStatus] = useState<"off" | "checking" | "signIn" | "consent" | "writing" | "done" | "failed">("off");
  const [text, setText] = useState("");
  const [failure, setFailure] = useState("");
  const [attempt, setAttempt] = useState(0);
  const accountKnown = !signedIn || user !== undefined;
  const consented = Boolean(user?.reading_preferences.ai_consent);

  useEffect(() => {
    if (!wanted || !accountKnown) {
      setStatus("off");
      return;
    }
    const controller = new AbortController();
    const { signal } = controller;
    setStatus("checking");
    void (async () => {
      const kept = await readTranslation(article.id, signal);
      if (signal.aborted) return;
      if (kept) {
        setText(kept);
        setStatus("done");
      } else if (!signedIn) setStatus("signIn");
      else if (!consented) setStatus("consent");
      else {
        setText("");
        setStatus("writing");
        const whole = await translateArticle(article.id, setText, signal);
        if (signal.aborted) return;
        setText(whole);
        setStatus("done");
      }
    })().catch((e) => {
      if (signal.aborted) return;
      setFailure(e instanceof ApiError ? e.message : MSG["MSG-26"]);
      setStatus("failed");
    });
    return () => controller.abort();
  }, [article.id, wanted, accountKnown, signedIn, consented, attempt]);

  return { status, text, failure, retry: () => setAttempt((n) => n + 1) };
}

/** Where the reader is in the article's text: the block at the top of the screen, and how far down the screen. */
function placeIn(body: HTMLElement | null) {
  const blocks = Array.from(body?.firstElementChild?.children ?? []);
  const index = blocks.findIndex((block) => block.getBoundingClientRect().bottom > TOP_OF_SCREEN);
  return index > 0 ? { index, top: blocks[index].getBoundingClientRect().top } : null;
}

/** The article's own text as collected, or its Vietnamese. A translation has the same paragraphs, so switching
 * keeps the reader at the same one. */
function FullReading({ article, wanted, signedIn, error, opening, onOpenInReader }: {
  article: Article; wanted: boolean; signedIn: boolean; error: string; opening: boolean; onOpenInReader?: () => void;
}) {
  const t = useT();
  const lang = useLang();
  const { status, text, failure, retry } = useTranslation(article, wanted, signedIn);
  const [asking, setAsking] = useState(false);
  const translated = wanted && text !== "" && (status === "writing" || status === "done");
  const content = translated ? text : article.content ?? "";
  const blocks = useMemo(() => parseMarkdown(content), [content]);
  const body = useRef<HTMLDivElement>(null);
  const place = useRef<ReturnType<typeof placeIn>>(null);
  const shown = useRef(wanted);
  if (shown.current !== wanted) {
    // Read before this render reaches the page, whichever switch changed the language.
    shown.current = wanted;
    place.current = placeIn(body.current);
  }

  useLayoutEffect(() => {
    const block = place.current && translated === wanted ? body.current?.firstElementChild?.children[place.current.index] : undefined;
    if (!block || !place.current) return;
    window.scrollBy({ top: block.getBoundingClientRect().top - place.current.top, behavior: "instant" });
    place.current = null;
  });

  return (
    <div>
      {translated && (
        <p className="mb-4 inline-flex items-center gap-2 rounded-full bg-accent-soft px-3 py-1 text-xs font-semibold text-accent-text">
          <Icon name="spark" size={14} />{t("catalog.translatedBadge")}
        </p>
      )}
      <h1 className="mb-4 font-display text-[34px] font-semibold leading-tight tracking-[-0.01em] sm:text-[42px]">{translated ? article.vi?.title ?? article.title : article.title}</h1>
      {translated && article.vi && <p className="mb-4 text-sm leading-relaxed text-muted"><span className="font-semibold">{t("catalog.originalTitle")}: </span><i>{article.title}</i></p>}
      <p className="mb-5 text-sm">{article.authors}{article.published_at ? ` · ${article.published_at}` : ""}</p>
      {wanted && status === "signIn" && (
        <p className="mb-6 rounded-xl bg-soft p-4 text-sm">
          <Link href="/login" className="font-semibold underline underline-offset-2">{t("catalog.translateSignIn")}</Link>
        </p>
      )}
      {wanted && status === "consent" && (
        <div className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-xl bg-soft p-4 text-sm">
          <p className="min-w-0 flex-1 basis-60">{t("catalog.translateConsent")}</p>
          <button type="button" onClick={() => setAsking(true)} className="btn-outline">{t("catalog.translateAgree")}</button>
        </div>
      )}
      {wanted && status === "failed" && (
        <div role="alert" className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-xl bg-soft p-4 text-sm">
          <p className="min-w-0 flex-1 basis-60">{failure}</p>
          <button type="button" onClick={retry} className="btn-outline">{t("catalog.translateRetry")}</button>
        </div>
      )}
      {wanted && status === "writing" && !text && <p role="status" className="mb-6 rounded-xl bg-soft p-4 text-sm">{t("catalog.translating")}</p>}
      {onOpenInReader && (
        <button type="button" onClick={onOpenInReader} disabled={opening} className="btn-outline mb-5 disabled:cursor-wait">
          {t(opening ? "catalog.opening" : "catalog.openInReader")}
        </button>
      )}
      {article.content_note && <p className="mb-8 rounded-xl bg-soft p-4 text-sm">{lang === "vi" ? article.content_note : t("catalog.note")}</p>}
      <div ref={body}>
        {translated || article.content !== undefined
          ? <MarkdownView blocks={blocks} renderRef={(n) => `[${n}]`} renderImage={articleFigure} className="break-words font-serif text-lg leading-[1.8] text-body" />
          : !error && <p className="text-muted">{t("catalog.loadingText")}</p>}
      </div>
      {translated && status === "writing" && <p role="status" className="mt-6 text-sm text-muted">{t("catalog.translatingMore")}</p>}
      {translated && status === "done" && (
        <p className="mt-8 border-t border-line pt-5 text-sm leading-relaxed text-muted">{t("catalog.translatedCredit", { authors: article.authors, source: article.source })}</p>
      )}
      <AiConsentDialog open={asking} what={t("catalog.translateWhat")} onAgreed={() => setAsking(false)} onCancel={() => setAsking(false)} />
    </div>
  );
}

/** Reading one article of the catalog, at the level the reader picks: a Quick Read where there is one, or the
 * original. Digest, the level between them, is yet to come. A signed-in reader can save it, or take the original
 * to the reader for highlights and notes; a visitor reads it here. */
export function ArticleReading({ article, topic, signedIn, error, opening, saved, onBack, onSave, onOpenInReader }: {
  article: Article;
  topic: string;
  signedIn: boolean;
  error: string;
  opening: boolean;
  saved: boolean;
  onBack: () => void;
  onSave: () => void;
  onOpenInReader: () => void;
}) {
  const t = useT();
  const lang = useLang();
  const top = useRef<HTMLElement>(null);
  const [level, setLevel] = useState<ReadingLevel>(() => startingLevel(article, lang));
  // The reader's choice for this article, until the site's own language is changed.
  const [chosen, setChosen] = useState<"vi" | "en" | null>(null);
  useEffect(() => setChosen(null), [lang]);
  const canTranslate = Boolean(article.translatable) && level === "full";
  const reading = chosen ?? lang;
  const quick = article.quick;
  const minutes = readingMinutes(article.word_count ?? 0);

  function pick(next: ReadingLevel) {
    setLevel(next);
    top.current?.scrollIntoView();
  }

  return (
    <article ref={top} className="mx-auto max-w-3xl scroll-mt-24">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <button type="button" onClick={onBack} className="btn-ghost -ml-3 px-3 text-sm text-accent-text">{t("catalog.back")}</button>
        <div className="ml-auto flex items-center gap-2">
          {signedIn && (
            <button type="button" disabled={saved || opening} onClick={onSave} className="btn-ghost h-10 gap-1.5 px-3 text-[13px] disabled:cursor-default">
              <Icon name={saved ? "check" : "bookmark"} size={15} />
              {saved ? t("feed.savedShort") : t("feed.save")}
            </button>
          )}
          {canTranslate && (
            <div role="group" aria-label={t("catalog.readLanguage")} className="segmented">
              <button type="button" aria-pressed={reading === "vi"} onClick={() => setChosen("vi")}>VN</button>
              <button type="button" aria-pressed={reading === "en"} onClick={() => setChosen("en")}>EN</button>
            </div>
          )}
        </div>
      </div>
      {quick && (
        <div role="tablist" aria-label={t("catalog.levels")} className="segmented mb-6">
          <button type="button" role="tab" aria-selected={level === "quick"} onClick={() => pick("quick")}>{t("catalog.levelQuick")}</button>
          <button type="button" role="tab" aria-selected={level === "full"} onClick={() => pick("full")}>{t("catalog.levelFull", { n: minutes })}</button>
        </div>
      )}
      <p className="eyebrow mb-3">{topic} · {article.source}{level === "full" && !canTranslate ? ` · ${article.language.toUpperCase()}` : ""}</p>
      <p className="mb-6 text-sm">
        <a href={article.url} target="_blank" rel="noreferrer" className="underline">{t("catalog.original")}</a>
        {" · "}<a href={article.license_url} target="_blank" rel="noreferrer" className="underline">{article.license}</a>
        {" · "}<a href={article.attribution_url} target="_blank" rel="noreferrer" className="underline">{t("catalog.credit")}</a>
      </p>
      {error && <p role="alert" className="mb-4 text-red-600">{error}</p>}
      {quick && level === "quick"
        ? <QuickReading article={article} quick={quick} signedIn={signedIn} onFull={() => pick("full")} />
        : <FullReading article={article} wanted={canTranslate && reading === "vi"} signedIn={signedIn} error={error} opening={opening} onOpenInReader={signedIn ? onOpenInReader : undefined} />}
    </article>
  );
}

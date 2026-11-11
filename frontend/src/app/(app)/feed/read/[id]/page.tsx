"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useMemo } from "react";

import { articleFigure } from "@/components/article-reading";
import { useAuth } from "@/components/auth-provider";
import { Icon } from "@/components/icons";
import { MarkdownView } from "@/components/notebook-markdown";
import { Alert, Spinner } from "@/components/ui";
import { ApiError } from "@/lib/api";
import { formatDate } from "@/lib/documents";
import { FEED } from "@/lib/features";
import { readingMinutes, useFeedArticle, useSave, type FeedArticle } from "@/lib/feed";
import { useT, type Key } from "@/lib/i18n";
import { parseMarkdown } from "@/lib/markdown";
import { MSG } from "@/lib/messages";
import { signInHref } from "@/lib/sign-in";

/** A feed article read where it is, as a visitor reads it: nothing goes in a library. A signed-in reader opening
 * the feed goes to their own copy in the reader instead; here they can still save it. */
export default function FeedArticlePage() {
  const t = useT();
  const { id } = useParams<{ id: string }>();
  const article = useFeedArticle(id);

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6">
      <Link href={FEED ? "/feed" : "/explore"} className="btn-ghost -ml-3 h-10 self-start px-3 text-sm">
        <Icon name="back" size={16} />
        {t("feed.back")}
      </Link>
      {article.isPending ? (
        <Spinner />
      ) : article.isError ? (
        <Alert>
          {article.error instanceof ApiError && article.error.status === 404
            ? t("feed.guest.notFound")
            : article.error instanceof Error
              ? article.error.message
              : MSG["MSG-99"]}
        </Alert>
      ) : (
        <Reading article={article.data} />
      )}
    </div>
  );
}

function Reading({ article }: { article: FeedArticle }) {
  const t = useT();
  const router = useRouter();
  const { session } = useAuth();
  const { save, saved, saving } = useSave(article.id, null);
  const blocks = useMemo(() => parseMarkdown(article.content), [article.content]);
  const here = `/feed/read/${article.id}`;

  const meta = [
    article.authors,
    t(`feed.kind.${article.kind}` as Key),
    t("common.minutesRead", { n: readingMinutes(article.word_count) }),
    article.published_at ? formatDate(article.published_at) : null,
  ].filter(Boolean);

  return (
    <article className="flex flex-col gap-5">
      {!session && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-soft p-4 text-sm">
          <p className="min-w-0 flex-1 basis-60">{t("feed.guest.note")}</p>
          <Link href={signInHref(here)} className="btn-outline">
            {t("feed.guest.signIn")}
          </Link>
        </div>
      )}
      <p className="eyebrow uppercase">
        {article.source_name}
        {article.language !== "vi" ? ` · ${article.language.toUpperCase()}` : ""}
      </p>
      <h1 className="font-display text-[34px] font-semibold leading-tight tracking-[-0.01em] sm:text-[42px]">{article.title}</h1>
      <p className="text-sm text-muted">{meta.join(" · ")}</p>
      <div className="flex flex-wrap items-center gap-2">
        {session && (
          <button type="button" className="btn-outline h-10 px-4 text-sm" disabled={saving || saved} aria-pressed={saved} onClick={() => void save()}>
            <Icon name={saved ? "check" : "bookmark"} size={16} />
            {t(saved ? "feed.savedShort" : "feed.short.saveLibrary")}
          </button>
        )}
        <a href={article.url} target="_blank" rel="noreferrer" className="btn-ghost h-10 px-3 text-sm">
          {t("feed.original")} ↗
        </a>
        <a href={article.license_url} target="_blank" rel="noreferrer" className="btn-ghost h-10 px-3 text-sm">
          {t("feed.licence", { license: article.license })}
        </a>
      </div>
      <MarkdownView
        blocks={blocks}
        renderRef={(n) => `[${n}]`}
        renderImage={articleFigure}
        className="break-words font-serif text-lg leading-[1.8] text-body"
      />
      <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-line pt-6">
        <button type="button" className="btn-primary h-11 px-5" onClick={() => router.push(FEED ? "/feed" : "/explore")}>
          {t("feed.back")}
          <Icon name="arrow" size={16} />
        </button>
        {!session && (
          <Link href={signInHref(here)} className="btn-ghost h-11 px-4 text-sm">
            {t("feed.guest.signIn")}
          </Link>
        )}
      </div>
    </article>
  );
}

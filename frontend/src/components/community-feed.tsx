"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { Icon } from "@/components/icons";
import { PostPager, kindLabel } from "@/components/post-cards";
import { Alert, Spinner, useModal } from "@/components/ui";
import { relativeTime } from "@/lib/doc-view";
import { TOPICS, type Topic } from "@/lib/feed";
import { useLang, useT, type Key } from "@/lib/i18n";
import { MSG } from "@/lib/messages";
import {
  REPORT_REASONS,
  useCommunity,
  useReport,
  useSavePost,
  useSavedPosts,
  type PublicPost,
  type PublicSource,
  type ReportReason,
} from "@/lib/posts";
import { useUi } from "@/lib/ui-store";

/** A name the author chose. Never their email: an author with no name is just a PureMind reader. */
export function useAuthorName() {
  const t = useT();
  return (name: string) => name.trim() || t("community.anonymous");
}

export function SourceLine({ source }: { source: PublicSource }) {
  const t = useT();
  return (
    <li className="flex flex-col gap-0.5 text-sm">
      {source.url ? (
        <a href={source.url} target="_blank" rel="noopener noreferrer nofollow" className="text-ink underline underline-offset-2">
          {source.title}
        </a>
      ) : (
        <span className="text-ink">{source.title}</span>
      )}
      {(source.credit || source.license) && (
        <span className="text-xs text-muted">
          {[source.credit, source.license && t("community.licensed", { license: source.license })].filter(Boolean).join(" · ")}
        </span>
      )}
    </li>
  );
}

/** A fixed reason and nothing more: admins act on the public text, not on what one reader wrote. */
export function ReportDialog({ path, onClose }: { path: string | null; onClose: () => void }) {
  const t = useT();
  const showToast = useUi((s) => s.showToast);
  const report = useReport();
  const ref = useModal(path !== null);
  const [reason, setReason] = useState<ReportReason>("copyright");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (path) {
      setReason("copyright");
      setError(null);
    }
  }, [path]);

  async function send() {
    if (!path) return;
    try {
      await report.mutateAsync({ path, reason });
      showToast(t("community.reported"));
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : MSG["MSG-99"]);
    }
  }

  return (
    <dialog
      ref={ref}
      aria-label={t("community.reportTitle")}
      onCancel={(e) => {
        e.preventDefault();
        if (!report.isPending) onClose();
      }}
      className="dialog w-[min(calc(100vw-32px),420px)]"
    >
      <div className="flex flex-col gap-3.5 p-[26px]">
        <h2 className="font-serif text-2xl font-medium">{t("community.reportTitle")}</h2>
        <div className="flex flex-col gap-1" role="radiogroup" aria-label={t("community.reportTitle")}>
          {REPORT_REASONS.map((r) => (
            <label key={r} className="flex min-h-11 cursor-pointer items-center gap-2.5 rounded-lg px-2 hover:bg-soft">
              <input type="radio" name="report-reason" checked={reason === r} onChange={() => setReason(r)} />
              <span className="text-[15px] text-ink">{t(`community.reason.${r}` as Key)}</span>
            </label>
          ))}
        </div>
        {error && <Alert>{error}</Alert>}
        <div className="flex justify-end gap-2.5">
          <button type="button" className="btn-outline" onClick={onClose} disabled={report.isPending}>
            {t("common.cancel")}
          </button>
          <button type="button" className="btn-primary" onClick={() => void send()} disabled={report.isPending}>
            {t("community.reportSend")}
          </button>
        </div>
      </div>
    </dialog>
  );
}

export function PostByline({ post }: { post: PublicPost }) {
  const t = useT();
  const lang = useLang();
  const authorName = useAuthorName();
  const name = authorName(post.author.name);
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-muted">
      <span aria-hidden className="grid h-7 w-7 place-items-center rounded-full bg-soft text-xs font-semibold text-ink">
        {name.charAt(0).toUpperCase()}
      </span>
      <span className="font-semibold text-ink">{name}</span>
      {post.published_at && <span>· {relativeTime(post.published_at, lang)}</span>}
      <span className="rounded-full bg-soft px-2 py-0.5 text-xs font-semibold text-ink">{t(kindLabel(post.kind))}</span>
      {post.topic && <span className="rounded-full bg-soft px-2 py-0.5 text-xs text-ink">{t(`feed.topic.${post.topic}` as Key)}</span>}
      {post.ai_assisted && (
        <span className="flex items-center gap-1 rounded-full bg-accent-soft px-2 py-0.5 text-xs font-semibold text-accent">
          <Icon name="spark" size={12} />
          {t("community.aiAssisted")}
        </span>
      )}
    </div>
  );
}

export function SaveButton({ post }: { post: PublicPost }) {
  const t = useT();
  const save = useSavePost();
  const showToast = useUi((s) => s.showToast);
  return (
    <button
      type="button"
      className="btn-ghost h-10 px-3 text-sm"
      aria-pressed={post.saved}
      disabled={save.isPending}
      onClick={() =>
        save.mutate(
          { id: post.id, saved: !post.saved },
          { onError: (e) => showToast(e instanceof Error ? e.message : MSG["MSG-99"]) },
        )
      }
    >
      <Icon name="bookmark" size={16} />
      {t(post.saved ? "community.saved" : "community.save")}
    </button>
  );
}

function PostItem({ post, onReport }: { post: PublicPost; onReport: () => void }) {
  const t = useT();
  return (
    <article className="card flex flex-col gap-3.5 p-4 sm:p-5">
      <PostByline post={post} />
      <h2 className="font-display text-[22px] font-semibold leading-snug text-ink">
        <Link href={`/community/${post.id}`} className="hover:underline">
          {post.title}
        </Link>
      </h2>
      <PostPager title={post.title} cards={post.cards} />
      {post.sources.length > 0 && (
        <details className="text-sm">
          <summary className="cursor-pointer text-muted">{t("community.sourcesCount", { n: post.sources.length })}</summary>
          <ul className="mt-2 flex flex-col gap-2">
            {post.sources.map((s, i) => (
              <SourceLine key={i} source={s} />
            ))}
          </ul>
        </details>
      )}
      <div className="flex flex-wrap items-center gap-1 border-t border-line pt-2.5">
        <SaveButton post={post} />
        <Link href={`/community/${post.id}#comments`} className="btn-ghost h-10 px-3 text-sm">
          <Icon name="note" size={16} />
          {t("community.discuss", { n: post.comment_count })}
        </Link>
        {!post.mine && (
          <button type="button" className="btn-ghost h-10 px-3 text-sm" onClick={onReport}>
            {t("community.report")}
          </button>
        )}
        <span className="flex-1" />
        <Link href={`/community/${post.id}`} className="btn-outline h-10 px-3.5 text-sm">
          {t("community.deepRead")}
          <Icon name="arrow" size={16} />
        </Link>
      </div>
    </article>
  );
}

/** What readers chose to publish, newest first: no likes, no follows, no ranking by attention. */
export function CommunityFeed() {
  const t = useT();
  const [topic, setTopic] = useState<Topic | null>(null);
  const [savedOnly, setSavedOnly] = useState(false);
  const [reporting, setReporting] = useState<string | null>(null);
  const feed = useCommunity(topic);
  const saved = useSavedPosts(savedOnly);
  const posts = savedOnly ? (saved.data ?? []) : (feed.data?.pages.flatMap((p) => p.items) ?? []);
  const loading = savedOnly ? saved.isPending : feed.isPending;
  const failure = savedOnly ? saved.error : feed.error;

  return (
    <div className="mx-auto flex w-full max-w-[640px] flex-col gap-4">
      <p className="text-sm text-muted">{t("community.lede")}</p>
      <div className="-mx-4 flex items-center gap-2 overflow-x-auto px-4 [scrollbar-width:none] sm:mx-0 sm:flex-wrap sm:px-0">
        <button type="button" className="chip h-10 shrink-0" aria-pressed={savedOnly} onClick={() => setSavedOnly(!savedOnly)}>
          <Icon name="bookmark" size={16} />
          {t("community.savedFilter")}
        </button>
        {!savedOnly && (
          <select
            aria-label={t("community.topicFilter")}
            value={topic ?? ""}
            onChange={(e) => setTopic((e.target.value || null) as Topic | null)}
            className="h-10 shrink-0 rounded-full border border-line bg-surface pl-3.5 pr-8 text-sm font-medium text-ink shadow-card outline-none focus:border-accent"
          >
            <option value="">{t("community.allTopics")}</option>
            {TOPICS.map((x) => (
              <option key={x} value={x}>
                {t(`feed.topic.${x}` as Key)}
              </option>
            ))}
          </select>
        )}
      </div>

      {loading ? (
        <Spinner />
      ) : failure ? (
        <Alert>{failure instanceof Error ? failure.message : MSG["MSG-99"]}</Alert>
      ) : posts.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-[22px] border-2 border-dashed border-field bg-surface/60 px-6 py-14 text-center">
          <span className="font-display text-2xl font-semibold">
            {t(savedOnly ? "community.noSaved" : "community.empty")}
          </span>
          {!savedOnly && (
            <>
              <span className="max-w-md text-[15px] text-muted">{t("community.emptyHint")}</span>
              <Link href="/notebooks" className="btn-primary">
                {t("community.startWriting")}
              </Link>
            </>
          )}
        </div>
      ) : (
        <>
          {posts.map((post) => (
            <PostItem key={post.id} post={post} onReport={() => setReporting(post.id)} />
          ))}
          {!savedOnly && feed.hasNextPage && (
            <button type="button" className="btn-outline self-center" disabled={feed.isFetchingNextPage} onClick={() => void feed.fetchNextPage()}>
              {t("community.more")}
            </button>
          )}
        </>
      )}
      <ReportDialog path={reporting} onClose={() => setReporting(null)} />
    </div>
  );
}

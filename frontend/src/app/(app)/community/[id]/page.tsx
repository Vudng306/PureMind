"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useMemo, useState } from "react";

import { PostByline, ReportDialog, SaveButton, SourceLine, useAuthorName } from "@/components/community-feed";
import { Icon } from "@/components/icons";
import { MarkdownView } from "@/components/notebook-markdown";
import { PostPager } from "@/components/post-cards";
import { Alert, ConfirmDialog, Spinner } from "@/components/ui";
import { ApiError } from "@/lib/api";
import { relativeTime } from "@/lib/doc-view";
import { useLang, useT } from "@/lib/i18n";
import { parseMarkdown } from "@/lib/markdown";
import { MSG } from "@/lib/messages";
import {
  MAX_COMMENT_CHARS,
  useAddComment,
  useComments,
  useCommunityPost,
  useDeleteComment,
  type PublicComment,
} from "@/lib/posts";
import { useUi } from "@/lib/ui-store";

function Comments({ postId, onReport }: { postId: string; onReport: (path: string) => void }) {
  const t = useT();
  const lang = useLang();
  const authorName = useAuthorName();
  const showToast = useUi((s) => s.showToast);
  const comments = useComments(postId);
  const add = useAddComment(postId);
  const remove = useDeleteComment();
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [toDelete, setToDelete] = useState<PublicComment | null>(null);
  const clean = draft.trim();

  async function send(e: React.FormEvent) {
    e.preventDefault();
    if (!clean) return;
    setError(null);
    try {
      await add.mutateAsync(clean);
      setDraft("");
    } catch (err) {
      setError(err instanceof Error ? err.message : MSG["MSG-99"]);
    }
  }

  async function confirmDelete() {
    if (!toDelete) return;
    try {
      await remove.mutateAsync(toDelete.id);
      showToast(t("community.commentDeleted"));
    } catch (err) {
      setError(err instanceof Error ? err.message : MSG["MSG-99"]);
    } finally {
      setToDelete(null);
    }
  }

  return (
    <section id="comments" className="flex scroll-mt-24 flex-col gap-3.5">
      <h2 className="font-display text-xl font-semibold">{t("community.commentsTitle", { n: comments.data?.length ?? 0 })}</h2>
      <form className="flex flex-col gap-2" onSubmit={(e) => void send(e)}>
        <label className="sr-only" htmlFor="comment">
          {t("community.commentLabel")}
        </label>
        <textarea
          id="comment"
          value={draft}
          maxLength={MAX_COMMENT_CHARS}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={t("community.commentPlaceholder")}
          className="min-h-[88px] w-full resize-y rounded-xl border border-field bg-surface p-3 text-[15px] text-ink outline-none focus:border-accent"
        />
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted">{t("community.commentPublic")}</span>
          <span className="flex-1" />
          <button type="submit" className="btn-primary h-10" disabled={!clean || add.isPending}>
            {t("community.commentSend")}
          </button>
        </div>
      </form>
      {error && <Alert>{error}</Alert>}
      {comments.isPending ? (
        <Spinner />
      ) : comments.isError ? (
        <Alert>{comments.error instanceof Error ? comments.error.message : MSG["MSG-99"]}</Alert>
      ) : comments.data.length === 0 ? (
        <p className="text-sm text-muted">{t("community.noComments")}</p>
      ) : (
        <ul className="flex flex-col gap-2.5">
          {comments.data.map((c) => (
            <li key={c.id} className="flex flex-col gap-1 rounded-xl border border-line bg-surface p-3.5">
              <span className="flex flex-wrap items-center gap-x-2 text-[13px] text-muted">
                <span className="font-semibold text-ink">{authorName(c.author.name)}</span>
                <span>· {relativeTime(c.created_at, lang)}</span>
                <span className="flex-1" />
                {c.mine ? (
                  <button type="button" className="font-semibold hover:text-danger" onClick={() => setToDelete(c)}>
                    {t("common.delete")}
                  </button>
                ) : (
                  <button type="button" className="font-semibold hover:text-ink" onClick={() => onReport(`comments/${c.id}`)}>
                    {t("community.report")}
                  </button>
                )}
              </span>
              <p className="whitespace-pre-line text-[15px] leading-relaxed text-body">{c.body}</p>
            </li>
          ))}
        </ul>
      )}
      <ConfirmDialog
        open={toDelete !== null}
        title={t("community.commentDeleteTitle")}
        busy={remove.isPending}
        onConfirm={() => void confirmDelete()}
        onCancel={() => setToDelete(null)}
      >
        {t("community.commentDeleteBody")}
      </ConfirmDialog>
    </section>
  );
}

/** Deep read: the post's cards, the longer text, its named sources and the discussion. */
export default function CommunityPostPage() {
  const t = useT();
  const { id } = useParams<{ id: string }>();
  const query = useCommunityPost(id);
  const [reporting, setReporting] = useState<string | null>(null);
  const blocks = useMemo(() => parseMarkdown(query.data?.body ?? ""), [query.data?.body]);

  if (query.isPending) return <Spinner />;
  if (query.isError) {
    const notFound = query.error instanceof ApiError && query.error.status === 404;
    return (
      <div className="mx-auto flex max-w-[720px] flex-col items-start gap-3">
        <Alert>{notFound ? t("community.notFound") : query.error instanceof Error ? query.error.message : MSG["MSG-99"]}</Alert>
        <Link href="/feed?scope=community" className="btn-outline">
          {t("community.back")}
        </Link>
      </div>
    );
  }
  const post = query.data;

  return (
    <div className="mx-auto flex max-w-[720px] flex-col gap-5">
      <Link href="/feed?scope=community" className="flex items-center gap-1 self-start text-sm text-muted hover:text-ink">
        <Icon name="back" size={16} />
        {t("community.back")}
      </Link>
      <PostByline post={post} />
      <h1 className="font-display text-3xl font-semibold leading-tight text-ink sm:text-[38px]">{post.title}</h1>
      <PostPager title={post.title} cards={post.cards} />
      <div className="flex flex-wrap items-center gap-1 border-y border-line py-2">
        <SaveButton post={post} />
        {post.mine ? (
          <Link href={`/publish/${post.id}`} className="btn-ghost h-10 px-3 text-sm">
            <Icon name="pencil" size={16} />
            {t("community.manageMine")}
          </Link>
        ) : (
          <button type="button" className="btn-ghost h-10 px-3 text-sm" onClick={() => setReporting(post.id)}>
            {t("community.report")}
          </button>
        )}
      </div>
      {post.body.trim() && (
        <MarkdownView
          blocks={blocks}
          renderRef={(n) => `[${n}]`}
          className="font-serif text-[18px] leading-[1.7] text-body"
        />
      )}
      {post.sources.length > 0 ? (
        <section className="flex flex-col gap-2 rounded-xl border border-line bg-surface p-4">
          <h2 className="eyebrow">{t("community.sources")}</h2>
          <ul className="flex flex-col gap-2.5">
            {post.sources.map((s, i) => (
              <SourceLine key={i} source={s} />
            ))}
          </ul>
        </section>
      ) : (
        <p className="text-xs text-muted">{t("community.noNamedSource")}</p>
      )}
      {post.ai_assisted && <p className="text-xs text-muted">{t("community.aiNote")}</p>}
      <Comments postId={post.id} onReport={setReporting} />
      <ReportDialog path={reporting} onClose={() => setReporting(null)} />
    </div>
  );
}

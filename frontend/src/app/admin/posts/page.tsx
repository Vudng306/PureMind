"use client";

import { useState } from "react";

import { Pager, SELECT_CLS } from "@/components/admin-parts";
import { Alert, ConfirmDialog, Spinner } from "@/components/ui";
import {
  useAdminComments,
  useAdminPosts,
  useCommentAction,
  usePostAction,
  type AdminComment,
  type AdminPost,
  type PostState,
} from "@/lib/admin-content";
import { formatDate } from "@/lib/documents";
import { useT, type Key } from "@/lib/i18n";
import { MSG } from "@/lib/messages";

const STATES: [PostState, Key][] = [
  ["all", "adminPosts.stateAll"],
  ["reported", "adminPosts.stateReported"],
  ["hidden", "adminPosts.stateHidden"],
];

function Reports({ reports }: { reports: Record<string, number> }) {
  const t = useT();
  const entries = Object.entries(reports);
  if (entries.length === 0) return null;
  return (
    <span className="flex flex-wrap gap-1.5">
      {entries.map(([reason, n]) => (
        <span key={reason} className="rounded-full bg-danger/10 px-2 py-0.5 text-xs font-semibold text-danger">
          {t(`community.reason.${reason}` as Key)} · {n}
        </span>
      ))}
    </span>
  );
}

const authorOf = (name: string, fallback: string) => name.trim() || fallback;

/**
 * Moderation looks only at what authors chose to make public: drafts, notebooks and documents never reach
 * this page. Every hide, show and delete goes to the audit log.
 */
export default function AdminPostsPage() {
  const t = useT();
  const [state, setState] = useState<PostState>("all");
  const [page, setPage] = useState(1);
  const posts = useAdminPosts(state, page);
  const comments = useAdminComments("reported");
  const hiddenComments = useAdminComments("hidden");
  const postAction = usePostAction();
  const commentAction = useCommentAction();
  const [toDelete, setToDelete] = useState<AdminPost | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = (action: () => Promise<unknown>) => {
    setError(null);
    action().catch((e) => setError(e instanceof Error ? e.message : MSG["MSG-99"]));
  };
  const commentRows: AdminComment[] = [
    ...(comments.data ?? []),
    ...(hiddenComments.data ?? []).filter((c) => !(comments.data ?? []).some((x) => x.id === c.id)),
  ];

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="page-title">{t("adminPosts.title")}</h1>
        <p className="max-w-3xl text-sm text-muted">{t("adminPosts.lede")}</p>
      </div>
      <label className="self-start">
        <span className="sr-only">{t("adminPosts.stateLabel")}</span>
        <select
          className={SELECT_CLS}
          value={state}
          onChange={(e) => {
            setState(e.target.value as PostState);
            setPage(1);
          }}
        >
          {STATES.map(([value, label]) => (
            <option key={value} value={value}>
              {t(label)}
            </option>
          ))}
        </select>
      </label>
      {error && <Alert>{error}</Alert>}

      {posts.isPending ? (
        <Spinner />
      ) : posts.isError ? (
        <Alert>{posts.error instanceof Error ? posts.error.message : MSG["MSG-99"]}</Alert>
      ) : posts.data.items.length === 0 ? (
        <p className="rounded-[14px] border border-dashed border-field px-6 py-10 text-center text-muted">{t("adminPosts.empty")}</p>
      ) : (
        <>
          <ul className="flex flex-col gap-3">
            {posts.data.items.map((post) => (
              <li key={post.id} className="card flex flex-col gap-2.5 p-4">
                <div className="flex flex-wrap items-center gap-2 text-[13px] text-muted">
                  <span className="font-semibold text-ink">{authorOf(post.author.name, t("community.anonymous"))}</span>
                  {post.published_at && <span>· {formatDate(post.published_at)}</span>}
                  <span className="rounded-full bg-soft px-2 py-0.5 text-xs font-semibold text-ink">{t(`post.kind.${post.kind}` as Key)}</span>
                  {post.hidden && <span className="rounded-full bg-danger/10 px-2 py-0.5 text-xs font-semibold text-danger">{t("adminPosts.hiddenBadge")}</span>}
                  {post.ai_assisted && <span className="text-xs">{t("community.aiAssisted")}</span>}
                </div>
                <span className="font-display text-lg font-semibold leading-snug text-ink">{post.title}</span>
                <Reports reports={post.reports} />
                <details className="text-sm">
                  <summary className="cursor-pointer text-muted">{t("adminPosts.readPublic", { n: post.cards.length })}</summary>
                  <div className="mt-2 flex flex-col gap-2">
                    {post.cards.map((card, i) => (
                      <p key={i} className="whitespace-pre-line rounded-lg bg-soft p-3 text-body">
                        {card.heading && <strong className="block text-ink">{card.heading}</strong>}
                        {card.body}
                      </p>
                    ))}
                    {post.body.trim() && <p className="whitespace-pre-line text-body">{post.body}</p>}
                    {post.sources.length > 0 && (
                      <ul className="flex flex-col gap-1 text-xs text-muted">
                        {post.sources.map((s, i) => (
                          <li key={i}>
                            {s.url ? (
                              <a href={s.url} target="_blank" rel="noopener noreferrer nofollow" className="underline">
                                {s.title}
                              </a>
                            ) : (
                              s.title
                            )}
                            {s.license ? ` · ${s.license}` : ""}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </details>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    className="btn-outline h-10 px-3.5 text-sm"
                    disabled={postAction.isPending}
                    onClick={() => run(() => postAction.mutateAsync({ id: post.id, action: post.hidden ? "show" : "hide" }))}
                  >
                    {t(post.hidden ? "adminPosts.show" : "adminPosts.hide")}
                  </button>
                  <button type="button" className="btn-ghost h-10 px-3 text-sm text-danger" onClick={() => setToDelete(post)}>
                    {t("common.delete")}
                  </button>
                </div>
              </li>
            ))}
          </ul>
          <Pager data={posts.data} onPage={setPage} />
        </>
      )}

      <section className="flex flex-col gap-3">
        <h2 className="font-display text-xl font-semibold">{t("adminPosts.comments")}</h2>
        {commentRows.length === 0 ? (
          <p className="text-sm text-muted">{t("adminPosts.noComments")}</p>
        ) : (
          <ul className="flex flex-col gap-2.5">
            {commentRows.map((c) => (
              <li key={c.id} className="flex flex-col gap-1.5 rounded-xl border border-line bg-surface p-3.5">
                <span className="flex flex-wrap items-center gap-x-2 text-[13px] text-muted">
                  <span className="font-semibold text-ink">{authorOf(c.author.name, t("community.anonymous"))}</span>
                  <span>· {formatDate(c.created_at)}</span>
                  {c.hidden && <span className="font-semibold text-danger">{t("adminPosts.hiddenBadge")}</span>}
                </span>
                <p className="whitespace-pre-line text-sm text-body">{c.body}</p>
                <Reports reports={c.reports} />
                <button
                  type="button"
                  className="btn-outline h-10 self-start px-3.5 text-sm"
                  disabled={commentAction.isPending}
                  onClick={() => run(() => commentAction.mutateAsync({ id: c.id, action: c.hidden ? "show" : "hide" }))}
                >
                  {t(c.hidden ? "adminPosts.show" : "adminPosts.hide")}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <ConfirmDialog
        open={toDelete !== null}
        title={t("adminPosts.deleteTitle")}
        busy={postAction.isPending}
        onCancel={() => setToDelete(null)}
        onConfirm={() => {
          const post = toDelete;
          setToDelete(null);
          if (post) run(() => postAction.mutateAsync({ id: post.id, action: "delete" }));
        }}
      >
        {t("adminPosts.deleteBody", { title: toDelete?.title ?? "" })}
      </ConfirmDialog>
    </div>
  );
}

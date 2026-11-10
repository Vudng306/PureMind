"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { Icon } from "@/components/icons";
import { PostPager, kindLabel } from "@/components/post-cards";
import { Alert, ConfirmDialog, Spinner } from "@/components/ui";
import { ApiError } from "@/lib/api";
import { TOPICS, type Topic } from "@/lib/feed";
import { useT, type Key } from "@/lib/i18n";
import { MSG } from "@/lib/messages";
import { useNotebook } from "@/lib/notebooks";
import {
  MAX_CARD_BODY,
  MAX_CARD_HEADING,
  MAX_POST_BODY,
  MAX_POST_CARDS,
  MAX_POST_TITLE,
  MIN_POST_CARDS,
  POST_KINDS,
  splitIntoCards,
  useDeletePost,
  useDraftPost,
  usePost,
  usePostCheck,
  usePublishPost,
  useUnpublishPost,
  useUpdatePost,
  type Post,
  type PostCard,
  type PostKind,
} from "@/lib/posts";
import { useAccount } from "@/lib/queries";
import { useUi } from "@/lib/ui-store";

const AUTOSAVE_MS = 1200;

/** Pulls the notes across, for free. Only here so that useNotebook runs only for a post that has a notebook. */
function SplitNotes({
  notebookId,
  disabled,
  onSplit,
}: {
  notebookId: string;
  disabled: boolean;
  onSplit: (cards: PostCard[], dropped: number) => void;
}) {
  const t = useT();
  const notebook = useNotebook(notebookId);
  const content = notebook.data?.content ?? "";
  return (
    <button
      type="button"
      className="btn-outline h-10 px-3.5 text-sm"
      disabled={disabled || !content.trim()}
      title={content.trim() ? undefined : t("studio.noNotes")}
      onClick={() => {
        const { cards, dropped } = splitIntoCards(content);
        onSplit(cards, dropped);
      }}
    >
      <Icon name="note" size={16} />
      {t("studio.splitNotes")}
    </button>
  );
}

function Studio({ post }: { post: Post }) {
  const t = useT();
  const router = useRouter();
  const showToast = useUi((s) => s.showToast);
  const account = useAccount();
  const update = useUpdatePost(post.id);
  const check = usePostCheck(post.id);
  const publish = usePublishPost(post.id);
  const unpublish = useUnpublishPost(post.id);
  const draftAi = useDraftPost(post.id);
  const remove = useDeletePost();
  const { mutateAsync: save } = update;

  const [kind, setKind] = useState<PostKind>(post.kind);
  const [title, setTitle] = useState(post.title);
  const [topic, setTopic] = useState<Topic | null>(post.topic);
  const [cards, setCards] = useState<PostCard[]>(post.cards);
  const [body, setBody] = useState(post.body);
  const [shown, setShown] = useState<string[]>(post.sources.filter((s) => s.shown).map((s) => s.id));
  const [rights, setRights] = useState(false);
  const [reviewed, setReviewed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [askAi, setAskAi] = useState(false);
  const [askDelete, setAskDelete] = useState(false);
  const [askUnpublish, setAskUnpublish] = useState(false);

  const published = post.status === "published";
  const locked = published;
  const hasND = post.sources.some((s) => s.no_derivatives);
  const isLink = kind === "link";
  const hasUrl = post.sources.some((s) => s.url);

  // What the server has, to save only what changed.
  const snapshot = JSON.stringify({ kind, title, topic, cards, body, shown_source_ids: shown });
  const stored = useRef(snapshot);
  const dirty = snapshot !== stored.current;

  async function flush(): Promise<boolean> {
    const next = snapshot;
    if (next === stored.current) return true;
    try {
      await save(JSON.parse(next));
      stored.current = next;
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : MSG["MSG-99"]);
      return false;
    }
  }

  useEffect(() => {
    if (!dirty || locked || update.isPending) return;
    const timer = setTimeout(() => void flush(), AUTOSAVE_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- flush reads the snapshot this effect depends on
  }, [snapshot, dirty, locked, update.isPending]);

  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);

  function setCard(i: number, patch: Partial<PostCard>) {
    setCards(cards.map((c, n) => (n === i ? { ...c, ...patch } : c)));
  }

  function moveCard(i: number, by: number) {
    const next = [...cards];
    const [card] = next.splice(i, 1);
    next.splice(i + by, 0, card);
    setCards(next);
  }

  function chooseKind(next: PostKind) {
    setKind(next);
    // A link says why in one card; going back to cards leaves what is there.
    if (next === "link" && cards.length !== 1) setCards(cards.length ? cards.slice(0, 1) : [{ heading: "", body: "" }]);
  }

  async function runAi() {
    setAskAi(false);
    setError(null);
    if (!(await flush())) return;
    try {
      const out = await draftAi.mutateAsync();
      const snap = JSON.stringify({ kind, title: out.title, topic, cards: out.cards, body, shown_source_ids: shown });
      stored.current = snap;
      setTitle(out.title);
      setCards(out.cards);
      setReviewed(false);
      showToast(t("studio.aiDone"));
    } catch (e) {
      setError(e instanceof Error ? e.message : MSG["MSG-99"]);
    }
  }

  async function doPublish() {
    setError(null);
    if (!(await flush())) return;
    try {
      await publish.mutateAsync({ confirm_rights: rights, confirm_reviewed: reviewed });
      showToast(t("studio.published"));
      router.push(`/community/${post.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : MSG["MSG-99"]);
      void check.refetch();
    }
  }

  async function doUnpublish() {
    setAskUnpublish(false);
    setError(null);
    try {
      await unpublish.mutateAsync();
      setRights(false);
      setReviewed(false);
      showToast(t("studio.unpublished"));
    } catch (e) {
      setError(e instanceof Error ? e.message : MSG["MSG-99"]);
    }
  }

  async function doDelete() {
    try {
      stored.current = snapshot;
      await remove.mutateAsync(post.id);
      showToast(t("studio.deleted"));
      router.replace("/library?view=shared");
    } catch (e) {
      setAskDelete(false);
      setError(e instanceof Error ? e.message : MSG["MSG-99"]);
    }
  }

  const issues = check.data?.issues ?? [];
  const errors = issues.filter((i) => i.level === "error");
  const warnings = issues.filter((i) => i.level === "warning");
  const checksCurrent = !dirty && !update.isPending && !check.isFetching;
  const canPublish =
    !published &&
    !post.hidden &&
    checksCurrent &&
    check.data?.can_publish === true &&
    rights &&
    (!post.ai_assisted || reviewed) &&
    !publish.isPending;
  const canAddCard = !isLink && cards.length < MAX_POST_CARDS && !locked;
  const field =
    "w-full rounded-lg border border-field bg-surface px-3 text-[15px] text-ink outline-none focus:border-focus disabled:opacity-70";
  const quotaLeft = account.data?.ai_quota_remaining;

  return (
    <div className="mx-auto flex max-w-[1180px] flex-col gap-5">
      <div className="flex flex-wrap items-center gap-2.5">
        <Link href="/library?view=shared" className="flex items-center gap-1 text-sm text-muted hover:text-ink">
          <Icon name="back" size={16} />
          {t("studio.back")}
        </Link>
        <span
          className={`flex h-6 items-center rounded-full px-2 text-xs font-semibold ${
            post.hidden ? "bg-danger/10 text-danger" : published ? "bg-success-soft text-success" : "bg-soft text-ink"
          }`}
        >
          {t(post.hidden ? "post.statusHidden" : published ? "post.statusPublished" : "post.statusDraft")}
        </span>
        {!locked && (
          <span className="text-xs text-muted" role="status">
            {t(update.isPending ? "nb.statusSaving" : dirty ? "nb.statusDirty" : "studio.savedPrivate")}
          </span>
        )}
        <span className="flex-1" />
        {published && !post.hidden && (
          <>
            <Link href={`/community/${post.id}`} className="btn-outline h-10 px-3.5 text-sm">
              {t("studio.viewPublic")}
            </Link>
            <button type="button" className="btn-outline h-10 px-3.5 text-sm" onClick={() => setAskUnpublish(true)}>
              {t("studio.unpublish")}
            </button>
          </>
        )}
        <button
          type="button"
          className="icon-btn h-10 w-10"
          aria-label={t("studio.delete")}
          title={t("studio.delete")}
          onClick={() => setAskDelete(true)}
        >
          <Icon name="trash" />
        </button>
      </div>

      <div className="flex flex-col gap-1">
        <h1 className="page-title">{t("studio.title")}</h1>
        <p className="max-w-3xl text-[15px] text-muted">{t("studio.lede")}</p>
      </div>

      {post.hidden && <Alert>{t("studio.hiddenNotice")}</Alert>}
      {published && !post.hidden && <Alert tone="info">{t("studio.publishedNotice")}</Alert>}
      {error && <Alert>{error}</Alert>}

      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_400px]">
        <div className="flex min-w-0 flex-col gap-5">
          <section className="card flex flex-col gap-3 p-5">
            <h2 className="eyebrow">{t("studio.kindTitle")}</h2>
            <div className="grid gap-2 sm:grid-cols-2">
              {POST_KINDS.map((k) => (
                <button
                  key={k}
                  type="button"
                  aria-pressed={kind === k}
                  disabled={locked || (k === "link" && !hasUrl) || (k === "summary" && hasND)}
                  onClick={() => chooseKind(k)}
                  className="flex flex-col gap-0.5 rounded-xl border border-line p-3 text-left hover:border-accent disabled:opacity-50 aria-pressed:border-accent aria-pressed:bg-accent-soft"
                >
                  <span className="text-[15px] font-semibold text-ink">{t(kindLabel(k))}</span>
                  <span className="text-xs leading-snug text-muted">
                    {t(
                      k === "summary" && hasND
                        ? "studio.summaryNdHint"
                        : k === "link" && !hasUrl
                          ? "studio.linkNoUrlHint"
                          : (`post.kindHint.${k}` as Key),
                    )}
                  </span>
                </button>
              ))}
            </div>
          </section>

          <section className="card flex flex-col gap-3.5 p-5">
            <label className="flex flex-col gap-1.5">
              <span className="text-sm text-muted">{t("studio.titleLabel")}</span>
              <input
                value={title}
                disabled={locked}
                maxLength={MAX_POST_TITLE}
                onChange={(e) => setTitle(e.target.value)}
                className={`${field} h-11`}
              />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-sm text-muted">{t("studio.topicLabel")}</span>
              <select
                value={topic ?? ""}
                disabled={locked}
                onChange={(e) => setTopic((e.target.value || null) as Topic | null)}
                className={`${field} h-11`}
              >
                <option value="">{t("studio.topicChoose")}</option>
                {TOPICS.map((x) => (
                  <option key={x} value={x}>
                    {t(`feed.topic.${x}` as Key)}
                  </option>
                ))}
              </select>
            </label>
          </section>

          <section className="card flex flex-col gap-3.5 p-5">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="eyebrow flex-1">
                {isLink ? t("studio.linkCard") : t("studio.cardsTitle", { n: cards.length, min: MIN_POST_CARDS, max: MAX_POST_CARDS })}
              </h2>
              {!isLink && post.notebook_id && (
                <SplitNotes
                  notebookId={post.notebook_id}
                  disabled={locked}
                  onSplit={(next, dropped) => {
                    setCards(next);
                    showToast(dropped ? t("studio.splitDropped", { n: dropped }) : t("studio.splitDone", { n: next.length }));
                  }}
                />
              )}
              {!isLink && (
                <button
                  type="button"
                  className="btn-outline h-10 px-3.5 text-sm"
                  disabled={locked || hasND || draftAi.isPending}
                  title={hasND ? t("studio.aiNdHint") : undefined}
                  onClick={() => setAskAi(true)}
                >
                  <Icon name="spark" size={16} />
                  {t(draftAi.isPending ? "studio.aiWorking" : "studio.aiDraft")}
                </button>
              )}
            </div>
            {hasND && !isLink && <Alert tone="info">{t("studio.ndNotice")}</Alert>}
            {cards.length === 0 && <p className="text-sm text-muted">{t("studio.noCards")}</p>}
            <ol className="flex flex-col gap-3">
              {cards.map((card, i) => (
                <li key={i} className="flex flex-col gap-2 rounded-xl border border-line p-3">
                  <div className="flex items-center gap-1">
                    <span className="flex-1 text-xs font-semibold text-muted">{t("studio.cardN", { n: i + 1 })}</span>
                    {!isLink && !locked && (
                      <>
                        <button type="button" className="icon-btn h-8 w-8" aria-label={t("studio.cardUp", { n: i + 1 })} disabled={i === 0} onClick={() => moveCard(i, -1)}>
                          <Icon name="up" size={16} />
                        </button>
                        <button type="button" className="icon-btn h-8 w-8" aria-label={t("studio.cardDown", { n: i + 1 })} disabled={i === cards.length - 1} onClick={() => moveCard(i, 1)}>
                          <Icon name="down" size={16} />
                        </button>
                        <button type="button" className="icon-btn h-8 w-8" aria-label={t("studio.cardRemove", { n: i + 1 })} onClick={() => setCards(cards.filter((_, n) => n !== i))}>
                          <Icon name="x" size={16} />
                        </button>
                      </>
                    )}
                  </div>
                  <label className="sr-only" htmlFor={`card-h-${i}`}>
                    {t("studio.cardHeading")}
                  </label>
                  <input
                    id={`card-h-${i}`}
                    value={card.heading}
                    disabled={locked}
                    maxLength={MAX_CARD_HEADING}
                    placeholder={t("studio.cardHeading")}
                    onChange={(e) => setCard(i, { heading: e.target.value })}
                    className={`${field} h-10 font-semibold`}
                  />
                  <label className="sr-only" htmlFor={`card-b-${i}`}>
                    {t("studio.cardBody")}
                  </label>
                  <textarea
                    id={`card-b-${i}`}
                    value={card.body}
                    disabled={locked}
                    maxLength={MAX_CARD_BODY}
                    placeholder={isLink ? t("studio.linkCardHint") : t("studio.cardBody")}
                    onChange={(e) => setCard(i, { body: e.target.value })}
                    className={`${field} min-h-[96px] resize-y py-2`}
                  />
                  <span className="self-end text-xs text-muted">
                    {card.body.length}/{MAX_CARD_BODY}
                  </span>
                </li>
              ))}
            </ol>
            {canAddCard && (
              <button type="button" className="btn-ghost h-10 self-start px-3 text-sm" onClick={() => setCards([...cards, { heading: "", body: "" }])}>
                <Icon name="plus" size={16} />
                {t("studio.addCard")}
              </button>
            )}
          </section>

          {!isLink && (
            <section className="card flex flex-col gap-2 p-5">
              <label className="flex flex-col gap-1.5">
                <span className="eyebrow">{t("studio.bodyLabel")}</span>
                <span className="text-sm text-muted">{t("studio.bodyHint")}</span>
                <textarea
                  value={body}
                  disabled={locked}
                  maxLength={MAX_POST_BODY}
                  onChange={(e) => setBody(e.target.value)}
                  className={`${field} min-h-[160px] resize-y py-2 font-mono text-[13.5px]`}
                />
              </label>
            </section>
          )}

          <section className="card flex flex-col gap-3 p-5">
            <h2 className="eyebrow">{t("studio.sourcesTitle")}</h2>
            <p className="text-sm text-muted">{t("studio.sourcesHint")}</p>
            {post.sources.length === 0 && <p className="text-sm text-muted">{t("studio.noSources")}</p>}
            <ul className="flex flex-col gap-2">
              {post.sources.map((s) => (
                <li key={s.id} className="flex items-start gap-2.5 rounded-xl border border-line p-3">
                  <input
                    id={`src-${s.id}`}
                    type="checkbox"
                    className="mt-1"
                    disabled={locked}
                    checked={shown.includes(s.id)}
                    onChange={(e) => setShown(e.target.checked ? [...shown, s.id] : shown.filter((x) => x !== s.id))}
                  />
                  <label htmlFor={`src-${s.id}`} className="flex min-w-0 flex-1 cursor-pointer flex-col gap-0.5">
                    <span className="text-sm font-semibold text-ink">{s.title}</span>
                    <span className="flex flex-wrap items-center gap-1.5 text-xs text-muted">
                      {s.license && (
                        <span className={`rounded-full px-1.5 py-0.5 font-semibold ${s.no_derivatives ? "bg-danger/10 text-danger" : "bg-soft text-ink"}`}>
                          {s.license}
                        </span>
                      )}
                      {s.url ? t("studio.sourceWeb") : t("studio.sourcePrivate")}
                      {s.document_id === null && ` · ${t("studio.sourceRemoved")}`}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          </section>
        </div>

        <aside className="flex flex-col gap-4 lg:sticky lg:top-[96px] lg:max-h-[calc(100vh-120px)] lg:self-start lg:overflow-y-auto">
          <section className="flex flex-col gap-2.5">
            <h2 className="eyebrow">{t("studio.previewTitle")}</h2>
            <p className="font-display text-xl font-semibold leading-snug text-ink">{title || t("studio.noTitle")}</p>
            {cards.length > 0 ? (
              <PostPager title={title} cards={cards} />
            ) : (
              <p className="rounded-xl border border-dashed border-line p-6 text-center text-sm text-muted">{t("studio.noCards")}</p>
            )}
          </section>

          {!published && !post.hidden && (
            <section className="card flex flex-col gap-3 p-4">
              <h2 className="eyebrow">{t("studio.checkTitle")}</h2>
              {!checksCurrent ? (
                <p className="text-sm text-muted">{t("studio.checking")}</p>
              ) : issues.length === 0 ? (
                <p className="flex items-center gap-2 text-sm text-success">
                  <Icon name="check" size={16} />
                  {t("studio.checkOk")}
                </p>
              ) : (
                <ul className="flex flex-col gap-2 text-sm">
                  {errors.map((i) => (
                    <li key={`${i.code}${i.message}`} className="flex gap-2 text-danger">
                      <Icon name="x" size={16} className="mt-0.5 shrink-0" />
                      <span>{i.message}</span>
                    </li>
                  ))}
                  {warnings.map((i) => (
                    <li key={`${i.code}${i.message}`} className="flex gap-2 text-body">
                      <Icon name="shield" size={16} className="mt-0.5 shrink-0" />
                      <span>{i.message}</span>
                    </li>
                  ))}
                </ul>
              )}
              <p className="text-xs text-muted">{t("studio.checkLimit")}</p>
              <label className="flex cursor-pointer items-start gap-2.5 text-sm text-ink">
                <input type="checkbox" className="mt-1" checked={rights} onChange={(e) => setRights(e.target.checked)} />
                <span>{t("studio.confirmRights")}</span>
              </label>
              {post.ai_assisted && (
                <label className="flex cursor-pointer items-start gap-2.5 text-sm text-ink">
                  <input type="checkbox" className="mt-1" checked={reviewed} onChange={(e) => setReviewed(e.target.checked)} />
                  <span>{t("studio.confirmReviewed")}</span>
                </label>
              )}
              <button type="button" className="btn-primary" disabled={!canPublish} onClick={() => void doPublish()}>
                {t(publish.isPending ? "common.working" : "studio.publish")}
              </button>
              <p className="text-xs text-muted">{t("studio.publishNote")}</p>
            </section>
          )}
        </aside>
      </div>

      <ConfirmDialog
        open={askAi}
        title={t("studio.aiConfirmTitle")}
        tone="primary"
        confirmLabel={t("studio.aiConfirm")}
        cancelLabel={t("common.cancel")}
        onConfirm={() => void runAi()}
        onCancel={() => setAskAi(false)}
      >
        {t("studio.aiConfirmBody", { n: quotaLeft ?? "?" })}
      </ConfirmDialog>
      <ConfirmDialog
        open={askUnpublish}
        title={t("studio.unpublishTitle")}
        tone="primary"
        confirmLabel={t("studio.unpublish")}
        cancelLabel={t("common.cancel")}
        busy={unpublish.isPending}
        onConfirm={() => void doUnpublish()}
        onCancel={() => setAskUnpublish(false)}
      >
        {t("studio.unpublishBody")}
      </ConfirmDialog>
      <ConfirmDialog
        open={askDelete}
        title={t("studio.deleteTitle")}
        busy={remove.isPending}
        onConfirm={() => void doDelete()}
        onCancel={() => setAskDelete(false)}
      >
        {t("studio.deleteBody")}
      </ConfirmDialog>
    </div>
  );
}

/** Publishing Studio: turn notes into a post, see it as readers will, check it, and only then publish. */
export default function PublishPage() {
  const t = useT();
  const { id } = useParams<{ id: string }>();
  const query = usePost(id);

  if (query.isPending) return <Spinner />;
  if (query.isError) {
    const notFound = query.error instanceof ApiError && query.error.status === 404;
    return (
      <div className="mx-auto flex max-w-[720px] flex-col items-start gap-3">
        <Alert>{notFound ? t("community.notFound") : query.error instanceof Error ? query.error.message : MSG["MSG-99"]}</Alert>
        <Link href="/library?view=shared" className="btn-outline">
          {t("studio.back")}
        </Link>
      </div>
    );
  }
  // A new key after publishing or unpublishing: what is on screen starts again from what is stored.
  return <Studio key={`${query.data.id}-${query.data.status}`} post={query.data} />;
}


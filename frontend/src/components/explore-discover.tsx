"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import { AiConsentDialog } from "@/components/ai-consent-dialog";
import { Icon } from "@/components/icons";
import { ApiError, api } from "@/lib/api";
import {
  MAX_QUERY, MIN_QUERY, actionsFor, checkUrl, hostOf, keep, loadKept, searchExplore, stageOf,
  type Action, type Found, type Kept, type Stage,
} from "@/lib/discover";
import { documentsKey, useSaveUrl } from "@/lib/documents";
import { useLang, useT, type Key } from "@/lib/i18n";
import { MSG, messageFor } from "@/lib/messages";
import { accountKey, useAccount } from "@/lib/queries";
import type { DocumentDetail, User } from "@/lib/types";
import { useUi } from "@/lib/ui-store";

const STARTERS = ["discover.starter1", "discover.starter2", "discover.starter3", "discover.starter4"] as const;
const STEPS = ["discover.step1", "discover.step2", "discover.step3"] as const;

/** Explore: the reader describes a subject, the AI finds three to five documents worth reading in full, and each
 * one says how to get it into the library, where reading, highlighting and notes happen. Not a list of links:
 * few results, each with the next step to take. */
export function ExploreDiscover({ signedIn }: { signedIn: boolean }) {
  const t = useT();
  const lang = useLang();
  const qc = useQueryClient();
  const { data: user } = useAccount();
  const [draft, setDraft] = useState("");
  const [kept, setKept] = useState<Kept | null>(null);
  const [pending, setPending] = useState<string | null>(null); // the subject being searched
  const [error, setError] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);

  const consented = Boolean(user?.reading_preferences.ai_consent);
  const quota = signedIn ? user?.chat_quota_remaining : undefined;
  const busy = pending !== null;
  const tooShort = draft.trim().length < MIN_QUERY;

  useEffect(() => {
    const last = loadKept();
    if (!last) return;
    setKept(last);
    setDraft(last.query);
  }, []);

  async function find(text?: string) {
    const query = (text ?? draft).trim().replace(/\s+/g, " ");
    if (query.length < MIN_QUERY || busy || !signedIn) return;
    setDraft(query);
    if (!consented) return setAsking(true);

    setError(null);
    setPending(query);
    try {
      const result = await searchExplore(query, lang);
      const next = { query, documents: result.documents };
      setKept(next);
      keep(next);
      qc.setQueryData<User>(accountKey, (u) => (u ? { ...u, chat_quota_remaining: result.chat_quota_remaining } : u));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : MSG["MSG-99"]);
    } finally {
      setPending(null);
    }
  }

  function startOver() {
    setKept(null);
    keep(null);
    setDraft("");
    setError(null);
    input.current?.focus();
  }

  return (
    <section className="mx-auto flex max-w-[860px] flex-col gap-8 pb-10" aria-label={t("nav.explore")}>
      <div className="flex flex-col gap-3 pt-2">
        <span className="eyebrow uppercase">{t("discover.eyebrow")}</span>
        <h1 className="page-title">{t("discover.title")}</h1>
        <p className="max-w-2xl text-[15px] leading-relaxed text-muted">{t("discover.lede")}</p>
      </div>

      <form
        className="flex flex-col gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void find();
        }}
      >
        <label className="sr-only" htmlFor="discover-query">
          {t("discover.inputLabel")}
        </label>
        <div className="card flex flex-col gap-3 p-4 focus-within:border-focus">
          <textarea
            ref={input}
            id="discover-query"
            value={draft}
            maxLength={MAX_QUERY}
            rows={3}
            placeholder={t("discover.placeholder")}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void find();
              }
            }}
            disabled={busy}
            className="min-h-[84px] w-full resize-none bg-transparent text-[16px] leading-relaxed text-ink outline-none placeholder:text-muted"
          />
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span className={`text-xs ${quota === 0 ? "text-danger" : "text-muted"}`}>
              {!signedIn
                ? t("discover.signInHint")
                : quota === 0
                  ? MSG["MSG-CHAT-QUOTA"]
                  : quota === undefined
                    ? t("discover.costHint")
                    : t("discover.quotaHint", { n: quota })}
            </span>
            {signedIn ? (
              <button type="submit" className="btn-primary" disabled={busy || tooShort || quota === 0}>
                <Icon name="spark" size={16} />
                {busy ? t("discover.searching") : t("discover.cta")}
              </button>
            ) : (
              <Link href="/login" className="btn-primary">
                {t("discover.signInCta")}
                <Icon name="arrow" size={16} />
              </Link>
            )}
          </div>
        </div>
        {error && (
          <p role="alert" className="rounded-[10px] bg-danger/10 px-3.5 py-2.5 text-sm text-danger">
            {error}
          </p>
        )}
      </form>

      {busy ? (
        <div role="status" className="card flex items-start gap-3 p-5">
          <span className="mt-0.5 h-5 w-5 shrink-0 animate-spin rounded-full border-2 border-line border-t-accent" aria-hidden />
          <div className="flex flex-col gap-1">
            <p className="text-[15px] font-medium text-ink">{t("discover.working")}</p>
            <p className="text-sm text-muted">{t("discover.workingHint")}</p>
          </div>
        </div>
      ) : kept ? (
        <Results kept={kept} onStartOver={startOver} />
      ) : (
        <div className="flex flex-col gap-8">
          {signedIn && (
            <div className="flex flex-col gap-2.5">
              <span className="text-sm font-medium text-muted">{t("discover.try")}</span>
              <div className="grid gap-2.5 sm:grid-cols-2">
                {STARTERS.map((key) => (
                  <button
                    key={key}
                    type="button"
                    className="card flex items-start gap-3 p-4 text-left text-[15px] leading-snug text-ink transition-colors hover:border-accent"
                    onClick={() => void find(t(key))}
                  >
                    <Icon name="spark" size={16} className="mt-0.5 shrink-0 text-accent-text" />
                    {t(key)}
                  </button>
                ))}
              </div>
            </div>
          )}
          <HowItWorks />
        </div>
      )}

      <AiConsentDialog
        open={asking}
        what={t("discover.consentWhat")}
        onAgreed={() => {
          setAsking(false);
          void find();
        }}
        onCancel={() => setAsking(false)}
      />
    </section>
  );
}

/** The road from a subject to a document being read, so the page says what happens after the search. */
function HowItWorks() {
  const t = useT();
  return (
    <ol className="grid gap-3 sm:grid-cols-3" aria-label={t("discover.howAria")}>
      {STEPS.map((key, i) => (
        <li key={key} className="flex flex-col gap-1.5 rounded-[14px] bg-soft p-4">
          <span className="flex h-6 w-6 items-center justify-center rounded-full bg-accent/15 text-xs font-semibold text-accent-text">{i + 1}</span>
          <span className="text-sm font-semibold text-ink">{t(`${key}.title` as Key)}</span>
          <span className="text-sm leading-relaxed text-muted">{t(`${key}.body` as Key)}</span>
        </li>
      ))}
    </ol>
  );
}

function Results({ kept, onStartOver }: { kept: Kept; onStartOver: () => void }) {
  const t = useT();
  const { query, documents } = kept;

  if (documents.length === 0) {
    return (
      <div className="card flex flex-col gap-3 p-6">
        <h2 className="text-[17px] font-semibold text-ink">{t("discover.noneTitle")}</h2>
        <p className="text-[15px] leading-relaxed text-muted">{t("discover.noneBody")}</p>
        <div>
          <button type="button" className="btn-outline" onClick={onStartOver}>
            {t("discover.another")}
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <h2 className="text-[19px] font-semibold leading-snug text-ink">{t("discover.resultsTitle", { n: documents.length })}</h2>
          <p className="truncate text-sm text-muted">{t("discover.resultsFor", { q: query })}</p>
        </div>
        <button type="button" className="btn-ghost h-9 px-3 text-sm" onClick={onStartOver}>
          <Icon name="plus" size={15} />
          {t("discover.another")}
        </button>
      </div>
      {documents.length < 3 && <p className="rounded-[10px] bg-soft px-3.5 py-2.5 text-sm text-muted">{t("discover.fewNote")}</p>}
      <ol className="flex flex-col gap-3">
        {documents.map((found, i) => (
          <li key={found.url}>
            <Result found={found} n={i + 1} />
          </li>
        ))}
      </ol>
      <p className="text-xs leading-relaxed text-muted">{t("discover.footnote")}</p>
    </div>
  );
}

const STATUS: Record<Stage, { key: Key; tone: string; icon?: "check" | "shield" | "link" }> = {
  checking: { key: "discover.status.checking", tone: "text-muted" },
  importable: { key: "discover.status.importable", tone: "text-accent-text", icon: "check" },
  blocked: { key: "discover.status.blocked", tone: "text-muted", icon: "shield" },
  "check-failed": { key: "discover.status.checkFailed", tone: "text-muted", icon: "link" },
  adding: { key: "discover.status.adding", tone: "text-muted" },
  processing: { key: "discover.status.processing", tone: "text-muted" },
  "import-failed": { key: "discover.status.importFailed", tone: "text-danger" },
  ready: { key: "discover.status.ready", tone: "text-accent-text", icon: "check" },
};

/** One chosen document: what it is, why it fits, and the step that gets it read. */
function Result({ found, n }: { found: Found; n: number }) {
  const t = useT();
  const { setAddOpen } = useUi();
  const saveUrl = useSaveUrl();
  const [addedId, setAddedId] = useState<string | null>(null);
  const [addError, setAddError] = useState<string | null>(null);
  const [guide, setGuide] = useState(false);

  // For a copy already in the library the server answers without visiting the site.
  const check = useQuery({
    queryKey: ["explore", "check", found.url],
    queryFn: () => checkUrl(found.url),
    retry: false,
    staleTime: Infinity,
    gcTime: 30 * 60_000,
  });
  const docId = addedId ?? found.document_id ?? check.data?.document_id ?? null;
  const doc = useQuery({
    queryKey: [...documentsKey, "detail", docId],
    queryFn: () => api<DocumentDetail>(`/documents/${docId}`),
    enabled: docId !== null,
    retry: false,
    refetchInterval: (q) => (["pending", "processing"].includes(q.state.data?.extraction_status ?? "") ? 2000 : false),
  });
  // A copy that was deleted since the search is no copy: the result goes back to what its check says.
  const added = doc.isError ? null : (doc.data ?? null);
  const loadingCopy = docId !== null && doc.isPending;
  const stage = stageOf({
    check: loadingCopy && addedId === null ? undefined : check.data,
    checkError: check.isError,
    adding: saveUrl.isPending || (loadingCopy && addedId !== null),
    addError: addError !== null,
    added,
  });
  const { primary, more } = actionsFor(stage);
  const status = STATUS[stage];
  const pdfUrl = check.data?.pdf_url ?? "";
  const showGuide = guide && more.includes("pdf-guide");

  async function add() {
    setAddError(null);
    try {
      const saved = await saveUrl.mutateAsync(check.data?.import_url || found.url);
      setAddedId(saved.id);
    } catch (e) {
      setAddError(e instanceof Error && e.message ? e.message : MSG["MSG-18"]);
    }
  }

  const meta = [found.authors, found.source, found.year ? String(found.year) : "", hostOf(found.url)].filter(Boolean);
  const detail =
    stage === "import-failed"
      ? (addError ?? messageFor(added?.extraction_error))
      : stage === "importable" && check.data
        ? check.data.kind === "pdf"
          ? t("discover.detail.pdf")
          : check.data.word_count
            ? t("common.minutesRead", { n: Math.max(1, Math.round(check.data.word_count / 220)) })
            : ""
        : "";

  function button(action: Action, main: boolean) {
    const cls = main ? "btn-primary" : "btn-outline";
    switch (action) {
      case "add":
      case "retry-add":
        return (
          <button key={action} type="button" className={cls} onClick={() => void add()}>
            {action === "add" && <Icon name="plus" size={16} />}
            {t(action === "add" ? "discover.add" : "discover.retryAdd")}
          </button>
        );
      case "open-reader":
        return (
          <Link key={action} href={`/reader/${docId}`} className={cls}>
            <Icon name="book" size={16} />
            {t("discover.openReader")}
          </Link>
        );
      case "open-source":
        return (
          <a key={action} href={found.url} target="_blank" rel="noopener noreferrer" className={cls}>
            {t(main ? "discover.openOriginal" : "discover.openSource")}
            <Icon name="arrow" size={15} className="-rotate-45" />
          </a>
        );
      case "wait":
        return (
          <button key={action} type="button" className={cls} disabled>
            <span className="h-4 w-4 animate-spin rounded-full border-2 border-on-accent/40 border-t-on-accent" aria-hidden />
            {t(stage === "checking" ? "discover.checking" : stage === "adding" ? "discover.adding" : "discover.processing")}
          </button>
        );
      case "recheck":
        return (
          <button key={action} type="button" className={cls} disabled={check.isFetching} onClick={() => void check.refetch()}>
            {t(check.isFetching ? "discover.checking" : "discover.recheck")}
          </button>
        );
      case "pdf-guide":
        return (
          <button key={action} type="button" className="btn-ghost" aria-expanded={showGuide} onClick={() => setGuide((open) => !open)}>
            <Icon name="upload" size={16} />
            {t("discover.pdfGuide")}
          </button>
        );
    }
  }

  return (
    <article className="card flex flex-col gap-3.5 p-5">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex h-6 min-w-6 shrink-0 items-center justify-center rounded-full bg-accent/15 px-1.5 text-xs font-semibold text-accent-text">{n}</span>
        <div className="flex min-w-0 flex-col gap-1">
          <span className="eyebrow uppercase">{t(`discover.kind.${found.kind}` as Key)}</span>
          <h3 className="font-serif text-[20px] font-medium leading-snug text-ink">{found.title}</h3>
          <p className="break-words text-[13px] text-muted">{meta.join(" · ")}</p>
        </div>
      </div>
      {found.summary && <p className="text-[15px] leading-relaxed text-body">{found.summary}</p>}
      {found.reason && (
        <p className="rounded-[10px] bg-soft px-3.5 py-2.5 text-sm leading-relaxed text-ink">
          <span className="font-semibold">{t("discover.why")}</span> {found.reason}
        </p>
      )}
      <div className="flex flex-col gap-3 border-t border-line pt-3.5">
        <p role="status" className={`flex items-start gap-2 text-sm ${status.tone}`}>
          {status.icon && <Icon name={status.icon} size={15} className="mt-0.5 shrink-0" />}
          <span>
            {t(status.key)}
            {detail && ` · ${detail}`}
          </span>
        </p>
        <div className="flex flex-wrap items-center gap-2">
          {button(primary, true)}
          {more.map((action) => button(action, false))}
        </div>
        {showGuide && (
          <div className="flex flex-col gap-2.5 rounded-[14px] bg-soft p-4 text-sm leading-relaxed text-ink">
            <p className="font-semibold">{t("discover.guide.title")}</p>
            {pdfUrl && (
              <p>
                {t("discover.guide.hasPdf")}{" "}
                <a href={pdfUrl} target="_blank" rel="noopener noreferrer" className="font-semibold text-accent-text underline underline-offset-2">
                  {t("discover.guide.openPdf")}
                </a>
              </p>
            )}
            <ol className="list-decimal space-y-1 pl-5 text-body">
              <li>{t("discover.guide.step1")}</li>
              <li>{t(pdfUrl ? "discover.guide.step2Known" : "discover.guide.step2")}</li>
              <li>{t("discover.guide.step3")}</li>
            </ol>
            <p className="text-[13px] text-muted">{t("discover.guide.note")}</p>
            <div>
              <button type="button" className="btn-outline" onClick={() => setAddOpen(true)}>
                <Icon name="upload" size={16} />
                {t("discover.guide.upload")}
              </button>
            </div>
          </div>
        )}
      </div>
    </article>
  );
}

"use client";

import { useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState } from "react";

import { AiConsentDialog } from "@/components/ai-consent-dialog";
import { HighlightPicker } from "@/components/highlight-picker";
import { Icon } from "@/components/icons";
import { NotebookMarkdown } from "@/components/notebook-markdown";
import { Alert, Spinner } from "@/components/ui";
import type { HighlightPage } from "@/lib/annotations";
import { ApiError, api } from "@/lib/api";
import { useDocuments } from "@/lib/documents";
import { useT } from "@/lib/i18n";
import { useCollections } from "@/lib/library";
import { MSG } from "@/lib/messages";
import { MAX_NOTEBOOK_SOURCES, afterGenerate, generateNotebook } from "@/lib/notebooks";
import { accountKey, useAccount } from "@/lib/queries";
import { useUi } from "@/lib/ui-store";

const selectCls =
  "h-10 max-w-full rounded-full border border-field bg-surface pl-3.5 pr-8 text-sm text-ink outline-none focus:border-focus";

/**
 * UI-07, FR-NB-01/02: step 1 pick highlights, step 2 the AI writes a draft (streamed), then it opens in the editor.
 * A notebook is written from one document (`?document=`), or by topic from the documents of one collection
 * (`?collection=`, or chosen here): never from highlights of anywhere.
 */
function NewNotebook() {
  const t = useT();
  const router = useRouter();
  const params = useSearchParams();
  const qc = useQueryClient();
  const showToast = useUi((s) => s.showToast);
  const { data: user } = useAccount();
  const fromDoc = params.get("document") ?? "";
  // Back to where it was opened: the Notebook (of one document, or all of it), the Library or the reader.
  const from = params.get("from");
  const back =
    from === "library"
      ? "/library"
      : from === "notebook"
        ? fromDoc
          ? `/notebooks/doc/${fromDoc}`
          : "/notebooks"
        : fromDoc
          ? `/reader/${fromDoc}`
          : "/notebooks";
  const backLabel = from === "library" ? "nav.library" : fromDoc && !from ? "notebooks.backToReader" : "notebooks.title";

  const { data: docs } = useDocuments("created_desc");
  const collections = useCollections();
  const [picked, setPicked] = useState(params.get("collection") ?? "");
  const shelves = collections.data ?? [];
  const collectionId = fromDoc ? "" : shelves.some((c) => c.id === picked) ? picked : (shelves[0]?.id ?? "");
  const docTitle = fromDoc ? docs?.find((d) => d.id === fromDoc)?.title : undefined;

  const [selected, setSelected] = useState<string[]>([]);
  const [writing, setWriting] = useState(false);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [askConsent, setAskConsent] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const quota = user?.ai_quota_remaining;
  const consented = Boolean(user?.reading_preferences.ai_consent);

  // Started from the reader: the open document's highlights are selected.
  useEffect(() => {
    if (!fromDoc) return;
    let cancelled = false;
    api<HighlightPage>(`/highlights?document_id=${fromDoc}&sort=document&page_size=${MAX_NOTEBOOK_SOURCES}`)
      .then((page) => !cancelled && setSelected(page.items.map((h) => h.id)))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [fromDoc]);

  useEffect(() => () => abortRef.current?.abort(), []);

  function start() {
    setError(null);
    if (selected.length === 0) return setError(MSG["MSG-27"]);
    if (!consented) return setAskConsent(true);
    void write();
  }

  async function write() {
    const controller = new AbortController();
    abortRef.current = controller;
    setWriting(true);
    setText("");
    let acc = "";
    try {
      const nb = await generateNotebook(
        // The AI names the notebook and writes in the language of the highlights.
        { highlight_ids: selected, ...(collectionId ? { collection_id: collectionId } : {}) },
        (delta) => {
          acc += delta;
          setText(acc);
        },
        controller.signal,
      );
      afterGenerate(qc, nb);
      showToast(t("notebooks.draftCreated"));
      router.replace(`/notebooks/${nb.id}`);
    } catch (e) {
      setWriting(false);
      if (controller.signal.aborted) return; // stopped by the user: back to the selection
      // FR-NB-02: the selection is kept so the user can try again.
      setError(e instanceof ApiError ? e.message : MSG["MSG-26"]);
      if (e instanceof ApiError && e.status === 429) void qc.invalidateQueries({ queryKey: accountKey });
    }
  }

  if (writing) {
    return (
      <div className="mx-auto flex max-w-[760px] flex-col gap-6">
        <div className="flex flex-wrap items-center gap-3">
          <div
            role="status"
            className="flex flex-1 items-center gap-2.5 rounded-lg bg-soft px-3.5 py-2.5 text-sm text-muted"
          >
            <span className="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-line border-t-accent" aria-hidden />
            {text ? t("notebooks.writingNotebook") : t("notebooks.sending", { n: selected.length })}
          </div>
          <button type="button" className="btn-outline" onClick={() => abortRef.current?.abort()}>
            {t("notebooks.stop")}
          </button>
        </div>
        <article className="rounded-2xl border border-line bg-surface px-5 py-6 sm:px-9 sm:py-8" aria-busy="true">
          {text ? (
            <NotebookMarkdown content={text} sources={null} />
          ) : (
            <div className="flex flex-col gap-3" aria-hidden>
              <span className="h-7 w-2/3 animate-pulse rounded bg-soft" />
              <span className="h-4 w-full animate-pulse rounded bg-soft" />
              <span className="h-4 w-5/6 animate-pulse rounded bg-soft" />
            </div>
          )}
        </article>
      </div>
    );
  }

  return (
    <div className="mx-auto flex max-w-[880px] flex-col gap-7">
      <div className="flex flex-col gap-2">
        <Link href={back} className="flex items-center gap-1 text-sm text-muted hover:text-ink">
          <Icon name="back" size={16} />
          {t(backLabel)}
        </Link>
        <h1 className="page-title">{t("notebooks.generate")}</h1>
        {docTitle && <p className="text-base font-semibold text-ink">{t("notebooks.ofDocument", { title: docTitle })}</p>}
        {!fromDoc && <p className="text-base font-semibold text-ink">{t("notebooks.ofCollection")}</p>}
        <p className="text-base text-muted">
          {t("notebooks.newLede", { max: MAX_NOTEBOOK_SOURCES })}
        </p>
      </div>

      {!fromDoc && shelves.length > 0 && (
        <label className="flex flex-wrap items-center gap-2.5">
          <span className="eyebrow">{t("notebooks.collection").toUpperCase()}</span>
          <select
            value={collectionId}
            onChange={(e) => {
              setPicked(e.target.value);
              setSelected([]);
            }}
            className={`${selectCls} w-[260px]`}
          >
            {shelves.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
      )}

      {fromDoc ? (
        <HighlightPicker selected={selected} onChange={setSelected} documentId={fromDoc} />
      ) : collections.isPending ? (
        <Spinner />
      ) : collectionId ? (
        <HighlightPicker key={collectionId} selected={selected} onChange={setSelected} collectionId={collectionId} />
      ) : (
        <div className="flex flex-col items-center gap-3.5 rounded-[14px] border border-dashed border-field px-6 py-14 text-center">
          <span className="font-serif text-[24px]">{t("notebooks.needCollection")}</span>
          <span className="max-w-md text-[15px] text-muted">{t("notebooks.needCollectionHint")}</span>
          <Link href="/library" className="btn-primary">
            {t("highlights.openLibrary")}
          </Link>
        </div>
      )}

      {(fromDoc || collectionId) && (
        <div className="glass sticky bottom-[92px] z-10 flex flex-col gap-3 rounded-[22px] border px-4 py-4 lg:bottom-3 sm:px-6">
          {error && <Alert>{error}</Alert>}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <button type="button" className="btn-primary" onClick={start} disabled={selected.length === 0 || quota === 0}>
              <Icon name="spark" size={16} />
              {t("notebooks.generateButton")}
            </button>
            {quota !== undefined && (
              <span className={`text-xs ${quota === 0 ? "text-danger" : "text-muted"}`}>
                {quota === 0 ? MSG["MSG-25"] : t("notebooks.quota", { n: quota })}
              </span>
            )}
          </div>
        </div>
      )}

      <AiConsentDialog
        open={askConsent}
        what={t("notebooks.consentWhat")}
        onAgreed={() => {
          setAskConsent(false);
          void write();
        }}
        onCancel={() => setAskConsent(false)}
      />
    </div>
  );
}

export default function NewNotebookPage() {
  return (
    <Suspense fallback={<Spinner />}>
      <NewNotebook />
    </Suspense>
  );
}

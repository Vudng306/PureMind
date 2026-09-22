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
import { useT, type Key } from "@/lib/i18n";
import { MSG } from "@/lib/messages";
import {
  MAX_NOTEBOOK_SOURCES,
  MAX_NOTEBOOK_TITLE,
  afterGenerate,
  generateNotebook,
  type NotebookLanguage,
} from "@/lib/notebooks";
import { accountKey, useAccount } from "@/lib/queries";
import { useUi } from "@/lib/ui-store";

const LANGUAGES: [NotebookLanguage, Key | null][] = [
  ["auto", "notebooks.langAuto"],
  ["vi", null], // a language's own name is the same in both interfaces
  ["en", null],
];
const LANGUAGE_NAME: Record<NotebookLanguage, string> = { auto: "", vi: "Tiếng Việt", en: "English" };

/** UI-07, FR-NB-01/02: step 1 pick highlights, step 2 the AI writes a draft (streamed), then it opens in the editor. */
function NewNotebook() {
  const t = useT();
  const router = useRouter();
  const params = useSearchParams();
  const qc = useQueryClient();
  const showToast = useUi((s) => s.showToast);
  const { data: user } = useAccount();
  const fromDoc = params.get("document") ?? "";

  const [selected, setSelected] = useState<string[]>([]);
  const [title, setTitle] = useState("");
  const [language, setLanguage] = useState<NotebookLanguage>("auto");
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
        { highlight_ids: selected, title, language },
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
        <Link href="/notebooks" className="flex items-center gap-1 text-sm text-muted hover:text-ink">
          <Icon name="back" size={16} />
          {t("notebooks.title")}
        </Link>
        <h1 className="font-serif text-4xl font-medium leading-[1.1] sm:text-5xl">{t("notebooks.generate")}</h1>
        <p className="text-base text-muted">
          {t("notebooks.newLede", { max: MAX_NOTEBOOK_SOURCES })}
        </p>
      </div>

      <HighlightPicker selected={selected} onChange={setSelected} initialDocId={fromDoc} />

      <div className="sticky bottom-0 z-10 -mx-4 flex flex-col gap-3 border-t border-line bg-bg px-4 py-4 sm:-mx-10 sm:px-10">
        {error && <Alert>{error}</Alert>}
        <div className="flex flex-wrap items-center gap-2.5">
          <label className="min-w-0 flex-1 basis-[240px]">
            <span className="sr-only">{t("notebooks.titleOptional")}</span>
            <input
              className="input h-11"
              placeholder={t("notebooks.titlePlaceholder")}
              value={title}
              maxLength={MAX_NOTEBOOK_TITLE}
              onChange={(e) => setTitle(e.target.value)}
            />
          </label>
          <label>
            <span className="sr-only">{t("notebooks.language")}</span>
            <select
              value={language}
              onChange={(e) => setLanguage(e.target.value as NotebookLanguage)}
              className="h-11 rounded-[10px] border border-field bg-surface pl-3.5 pr-8 text-sm text-ink outline-none focus:border-accent"
            >
              {LANGUAGES.map(([value, label]) => (
                <option key={value} value={value}>
                  {label ? t(label) : LANGUAGE_NAME[value]}
                </option>
              ))}
            </select>
          </label>
          <button type="button" className="btn-primary" onClick={start} disabled={selected.length === 0 || quota === 0}>
            <Icon name="spark" size={16} />
            {t("notebooks.generateN", { n: selected.length })}
          </button>
        </div>
        {quota !== undefined && (
          <span className={`text-xs ${quota === 0 ? "text-danger" : "text-muted"}`}>
            {quota === 0 ? MSG["MSG-25"] : t("notebooks.quota", { n: quota })}
          </span>
        )}
      </div>

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

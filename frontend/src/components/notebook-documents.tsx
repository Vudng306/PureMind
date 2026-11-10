"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { Icon } from "@/components/icons";
import { Alert, Spinner, useModal } from "@/components/ui";
import { ApiError, api } from "@/lib/api";
import { KIND_CLASS, KIND_LABEL } from "@/lib/doc-view";
import { useDocuments } from "@/lib/documents";
import { normalize } from "@/lib/find";
import { useT } from "@/lib/i18n";
import { noDerivatives } from "@/lib/library";
import { MSG } from "@/lib/messages";
import { useLinkDocument, useUnlinkDocument, type Notebook, type NotebookDocument } from "@/lib/notebooks";
import type { Summary } from "@/lib/summary";
import { useUi } from "@/lib/ui-store";

/** The saved summary as Markdown the author can then edit. */
export function summaryMarkdown(summary: Summary, title: string): string {
  const lines = [`## ${title}`, "", ...summary.key_points.map((p) => `- ${p}`)];
  if (summary.conclusion.trim()) lines.push("", summary.conclusion.trim());
  return lines.join("\n");
}

function AddDocumentDialog({
  open,
  linked,
  busy,
  error,
  onPick,
  onClose,
}: {
  open: boolean;
  linked: Set<string>;
  busy: boolean;
  error: string | null;
  onPick: (id: string) => void;
  onClose: () => void;
}) {
  const t = useT();
  const ref = useModal(open);
  const docs = useDocuments("created_desc");
  const [query, setQuery] = useState("");
  useEffect(() => {
    if (open) setQuery("");
  }, [open]);
  const q = normalize(query.trim());
  const shown = (docs.data ?? []).filter((d) => !linked.has(d.id)).filter((d) => !q || normalize(d.title).includes(q));

  return (
    <dialog
      ref={ref}
      aria-label={t("nbdoc.add")}
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onClose();
      }}
      className="dialog w-[min(calc(100vw-32px),560px)]"
    >
      <div className="flex max-h-[calc(100vh-32px)] flex-col gap-3 p-[26px]">
        <div className="flex items-center gap-3">
          <h2 className="flex-1 font-serif text-2xl font-medium">{t("nbdoc.add")}</h2>
          <button type="button" className="icon-btn" aria-label={t("common.close")} onClick={onClose} disabled={busy}>
            <Icon name="x" />
          </button>
        </div>
        <p className="text-sm text-muted">{t("nbdoc.addHint")}</p>
        <label className="flex h-10 items-center gap-2 rounded-full border border-line bg-surface px-3.5 text-muted focus-within:border-focus">
          <Icon name="search" size={16} />
          <span className="sr-only">{t("library.filterName")}</span>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("library.filterPlaceholder")}
            className="min-w-0 flex-1 bg-transparent text-sm text-ink outline-none"
          />
        </label>
        {error && <Alert>{error}</Alert>}
        <div className="flex min-h-[120px] flex-col gap-0.5 overflow-y-auto">
          {docs.isPending ? (
            <Spinner />
          ) : shown.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted">{t("nbdoc.noneToAdd")}</p>
          ) : (
            shown.map((d) => (
              <button
                key={d.id}
                type="button"
                disabled={busy}
                className="flex min-h-11 items-center gap-2.5 rounded-lg px-2.5 py-2 text-left hover:bg-soft disabled:opacity-60"
                onClick={() => onPick(d.id)}
              >
                <span className={`flex h-6 w-11 shrink-0 items-center justify-center rounded-[5px] text-[11px] font-bold ${KIND_CLASS[d.file_type]}`}>
                  {KIND_LABEL[d.file_type]}
                </span>
                <span className="min-w-0 flex-1 truncate text-sm text-ink">{d.title}</span>
              </button>
            ))
          )}
        </div>
      </div>
    </dialog>
  );
}

function DocumentRow({
  doc,
  busy,
  onInsertSummary,
  onUnlink,
}: {
  doc: NotebookDocument;
  busy: boolean;
  onInsertSummary: () => void;
  onUnlink: () => void;
}) {
  const t = useT();
  const nd = noDerivatives(doc.license);
  return (
    <li className="flex flex-col gap-1.5 rounded-xl border border-line bg-surface p-3">
      <div className="flex items-start gap-2.5">
        <span className={`mt-0.5 flex h-6 w-11 shrink-0 items-center justify-center rounded-[5px] text-[11px] font-bold ${KIND_CLASS[doc.file_type]}`}>
          {KIND_LABEL[doc.file_type]}
        </span>
        <Link href={`/reader/${doc.id}`} className="min-w-0 flex-1 text-sm font-semibold leading-snug text-ink hover:underline">
          {doc.title}
        </Link>
        {doc.linked && (
          <button
            type="button"
            className="icon-btn -mr-1.5 -mt-1.5 h-8 w-8 text-muted"
            aria-label={t("nbdoc.unlink", { title: doc.title })}
            title={t("nbdoc.unlinkHint")}
            disabled={busy}
            onClick={onUnlink}
          >
            <Icon name="x" size={16} />
          </button>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-muted">
        {doc.highlight_count > 0 && <span>{t("nb.groupCount", { n: doc.highlight_count })}</span>}
        {nd ? (
          <span className="rounded-full bg-danger/10 px-1.5 py-0.5 font-semibold text-danger" title={t("nbdoc.ndHint")}>
            {doc.license}
          </span>
        ) : (
          <button type="button" className="font-semibold text-accent-text hover:underline" disabled={busy} onClick={onInsertSummary}>
            {t("nbdoc.insertSummary")}
          </button>
        )}
      </div>
    </li>
  );
}

/** Linked documents in the notebook's side panel. They stay managed in the library: no second copy is kept. */
export function NotebookDocuments({
  notebook,
  onInsert,
}: {
  notebook: Notebook;
  onInsert: (markdown: string, aiModel: string) => void;
}) {
  const t = useT();
  const showToast = useUi((s) => s.showToast);
  const link = useLinkDocument(notebook.id);
  const unlink = useUnlinkDocument(notebook.id);
  const [adding, setAdding] = useState(false);
  const [linkError, setLinkError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const linked = new Set(notebook.documents.map((d) => d.id));

  /** Only a summary that already exists: this never asks the AI for a new one. */
  async function insertSummary(doc: NotebookDocument) {
    setBusy(true);
    try {
      const summary = await api<Summary>(`/documents/${doc.id}/summary`);
      onInsert(summaryMarkdown(summary, doc.title), summary.ai_model);
      showToast(t("nbdoc.summaryInserted"));
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) showToast(t("nbdoc.noSummary"));
      else showToast(e instanceof Error ? e.message : MSG["MSG-99"]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="flex flex-col gap-2" aria-label={t("nbdoc.title")}>
      <div className="flex items-center gap-2">
        <h2 className="eyebrow flex-1">{t("nbdoc.count", { n: notebook.documents.length })}</h2>
        <button
          type="button"
          className="btn-ghost h-9 px-3 text-sm"
          onClick={() => {
            setLinkError(null);
            setAdding(true);
          }}
        >
          <Icon name="plus" size={16} />
          {t("nbdoc.addShort")}
        </button>
      </div>
      {notebook.documents.length === 0 ? (
        <p className="text-sm text-muted">{t("nbdoc.none")}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {notebook.documents.map((doc) => (
            <DocumentRow
              key={doc.id}
              doc={doc}
              busy={busy || unlink.isPending}
              onInsertSummary={() => void insertSummary(doc)}
              onUnlink={() =>
                unlink.mutate(doc.id, { onError: (e) => showToast(e instanceof Error ? e.message : MSG["MSG-99"]) })
              }
            />
          ))}
        </ul>
      )}
      <AddDocumentDialog
        open={adding}
        linked={linked}
        busy={link.isPending}
        error={linkError}
        onClose={() => setAdding(false)}
        onPick={(id) =>
          link.mutate(id, {
            onSuccess: () => setAdding(false),
            onError: (e) => setLinkError(e instanceof Error ? e.message : MSG["MSG-99"]),
          })
        }
      />
    </section>
  );
}

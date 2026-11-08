"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { Icon } from "@/components/icons";
import { Alert, Spinner, useModal } from "@/components/ui";
import { useT } from "@/lib/i18n";
import { MSG } from "@/lib/messages";
import { MAX_NOTEBOOK_TITLE, createNotebook, linkNotebookDocument, notebooksKey, useNotebooks } from "@/lib/notebooks";
import type { DocumentListItem } from "@/lib/types";
import { useUi } from "@/lib/ui-store";

/** Link a library document to a notebook, new or existing. Nothing is copied: the document stays in the library. */
export function AddToNotebookDialog({ doc, onClose }: { doc: DocumentListItem | null; onClose: () => void }) {
  const t = useT();
  const router = useRouter();
  const qc = useQueryClient();
  const showToast = useUi((s) => s.showToast);
  const ref = useModal(doc !== null);
  const notebooks = useNotebooks();
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (doc) {
      setTitle("");
      setError(null);
    }
  }, [doc]);

  async function run(action: () => Promise<{ id: string }>) {
    setBusy(true);
    setError(null);
    try {
      const nb = await action();
      void qc.invalidateQueries({ queryKey: notebooksKey });
      showToast(t("addNb.done"));
      onClose();
      router.push(`/notebooks/${nb.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : MSG["MSG-99"]);
    } finally {
      setBusy(false);
    }
  }

  const clean = title.trim();

  return (
    <dialog
      ref={ref}
      aria-label={t("addNb.title")}
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onClose();
      }}
      className="dialog w-[min(calc(100vw-32px),520px)]"
    >
      <div className="flex max-h-[calc(100vh-32px)] flex-col gap-3.5 p-[26px]">
        <div className="flex items-start gap-3">
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <h2 className="font-serif text-2xl font-medium">{t("addNb.title")}</h2>
            <p className="truncate text-sm text-muted">{doc?.title}</p>
          </div>
          <button type="button" className="icon-btn" aria-label={t("common.close")} onClick={onClose} disabled={busy}>
            <Icon name="x" />
          </button>
        </div>
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (clean && doc) void run(() => createNotebook({ title: clean, document_id: doc.id }));
          }}
        >
          <label className="sr-only" htmlFor="new-notebook">
            {t("addNb.newLabel")}
          </label>
          <input
            id="new-notebook"
            value={title}
            maxLength={MAX_NOTEBOOK_TITLE}
            placeholder={t("addNb.newLabel")}
            onChange={(e) => setTitle(e.target.value)}
            className="h-11 min-w-0 flex-1 rounded-lg border border-field bg-surface px-3 text-[15px] text-ink outline-none focus:border-accent"
          />
          <button type="submit" className="btn-primary h-11" disabled={!clean || busy}>
            {t("addNb.create")}
          </button>
        </form>
        {error && <Alert>{error}</Alert>}
        <div className="flex min-h-0 flex-col gap-1 overflow-y-auto">
          <span className="eyebrow">{t("addNb.existing")}</span>
          {notebooks.isPending ? (
            <Spinner />
          ) : !notebooks.data?.length ? (
            <p className="text-sm text-muted">{t("addNb.none")}</p>
          ) : (
            notebooks.data.map((nb) => (
              <button
                key={nb.id}
                type="button"
                disabled={busy}
                className="flex min-h-11 items-center gap-2 rounded-lg px-3 py-2 text-left text-[15px] text-ink hover:bg-soft disabled:opacity-60"
                onClick={() => doc && void run(() => linkNotebookDocument(nb.id, doc.id))}
              >
                <Icon name="note" size={16} className="shrink-0 text-muted" />
                <span className="min-w-0 flex-1 truncate">{nb.title}</span>
                {nb.topic && <span className="shrink-0 text-xs text-muted">{nb.topic}</span>}
              </button>
            ))
          )}
        </div>
      </div>
    </dialog>
  );
}

"use client";

import { useEffect, useState } from "react";

import { CITATION_TYPES, EMPTY_CITATION, authorsToText, bibtexEntry, parseDoi, textToAuthors } from "@/lib/citation";
import { MAX_DOCUMENT_TITLE, lookupDoi, useUpdateDocument } from "@/lib/documents";
import { useT, type Key } from "@/lib/i18n";
import { MSG } from "@/lib/messages";
import type { Citation, CitationType, DocumentListItem } from "@/lib/types";
import { useUi } from "@/lib/ui-store";

import { Icon } from "./icons";
import { Alert, useModal } from "./ui";

const TYPE_LABEL: Record<CitationType, Key> = {
  article: "cite.typeArticle",
  book: "cite.typeBook",
  chapter: "cite.typeChapter",
  conference: "cite.typeConference",
  thesis: "cite.typeThesis",
  report: "cite.typeReport",
  misc: "cite.typeMisc",
};

/** The fields as the user types them: authors one per line, the year still a string. */
interface Form {
  title: string;
  type: CitationType;
  authors: string;
  container: string;
  publisher: string;
  year: string;
  volume: string;
  issue: string;
  pages: string;
  doi: string;
}

const toForm = (title: string, c: Citation): Form => ({
  title,
  type: c.type,
  authors: authorsToText(c.authors),
  container: c.container,
  publisher: c.publisher,
  year: c.year ? String(c.year) : "",
  volume: c.volume,
  issue: c.issue,
  pages: c.pages,
  doi: c.doi,
});

const oneLine = (s: string) => s.split(/\s+/).filter(Boolean).join(" ");

/** The title and citation the form holds, or the message saying what is wrong with it. */
function read(form: Form): { title: string; citation: Citation } | Key {
  const title = oneLine(form.title);
  if (!title) return "library.titleRequired";
  const year = form.year.trim() ? Number(form.year) : null;
  if (year !== null && !(Number.isInteger(year) && year >= 1000 && year <= 2100)) return "cite.yearInvalid";
  const doi = form.doi.trim() ? parseDoi(form.doi) : "";
  if (doi === null) return "add.doiInvalid";
  return {
    title,
    citation: {
      type: form.type,
      authors: textToAuthors(form.authors),
      container: oneLine(form.container),
      publisher: oneLine(form.publisher),
      year,
      volume: oneLine(form.volume),
      issue: oneLine(form.issue),
      pages: oneLine(form.pages),
      doi,
    },
  };
}

const field = "h-11 rounded-lg border border-field bg-surface px-3 text-[15px] text-ink outline-none focus:border-focus";
const label = "flex min-w-0 flex-col gap-1.5 text-sm text-muted";

/** How a document is cited: typed in, or filled in from its DOI. What the BibTeX export writes. */
export function CitationDialog({ doc, onClose }: { doc: DocumentListItem | null; onClose: () => void }) {
  const t = useT();
  const ref = useModal(doc !== null);
  const { showToast } = useUi();
  const update = useUpdateDocument();
  const [form, setForm] = useState<Form>(toForm("", EMPTY_CITATION));
  const [filling, setFilling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const busy = filling || update.isPending;

  useEffect(() => {
    if (!doc) return;
    setForm(toForm(doc.title, doc.citation ?? EMPTY_CITATION));
    setError(null);
    setNotice(null);
  }, [doc]);

  const set = (key: keyof Form) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
    setForm((f) => ({ ...f, [key]: e.target.value }));

  async function fill() {
    const doi = parseDoi(form.doi);
    setNotice(null);
    if (!doi) return setError(t("add.doiInvalid"));
    setError(null);
    setFilling(true);
    try {
      const found = await lookupDoi(doi);
      setForm((f) => toForm(found.title || f.title, found.citation));
      setNotice(t("cite.filled"));
    } catch (err) {
      setError(err instanceof Error ? err.message : MSG["MSG-99"]);
    } finally {
      setFilling(false);
    }
  }

  async function copy() {
    if (!doc) return;
    const data = read(form);
    setNotice(null);
    if (typeof data === "string") return setError(t(data));
    setError(null);
    try {
      await navigator.clipboard.writeText(`${bibtexEntry({ ...data, url: doc.url, created_at: doc.created_at })}\n`);
      setNotice(t("cite.copied"));
    } catch {
      setError(MSG["MSG-99"]);
    }
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!doc || busy) return;
    const data = read(form);
    setNotice(null);
    if (typeof data === "string") return setError(t(data));
    setError(null);
    try {
      await update.mutateAsync({ id: doc.id, patch: data });
      onClose();
      showToast(t("cite.saved"));
    } catch (err) {
      setError(err instanceof Error ? err.message : MSG["MSG-99"]);
    }
  }

  return (
    <dialog
      ref={ref}
      aria-labelledby="citation-title"
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onClose();
      }}
      className="dialog overflow-y-auto"
    >
      <form className="flex flex-col gap-4 p-5 sm:p-[26px]" onSubmit={save} noValidate>
        <div className="flex flex-col gap-1">
          <h2 id="citation-title" className="font-serif text-2xl font-medium">
            {t("cite.title")}
          </h2>
          <p className="text-sm leading-normal text-muted">{t("cite.lede")}</p>
        </div>

        <div className="flex items-end gap-2">
          <label className={`${label} flex-1`}>
            DOI
            <input
              className={field}
              value={form.doi}
              onChange={set("doi")}
              placeholder="10.1038/nature14539"
              maxLength={300}
              inputMode="url"
              autoComplete="off"
              spellCheck={false}
            />
          </label>
          <button type="button" className="btn-outline h-11 shrink-0 px-3.5 text-sm" onClick={fill} disabled={busy || !form.doi.trim()}>
            <Icon name="search" size={16} />
            {t(filling ? "cite.filling" : "cite.fill")}
          </button>
        </div>

        <label className={label}>
          {t("cite.docTitle")}
          <input className={field} value={form.title} onChange={set("title")} maxLength={MAX_DOCUMENT_TITLE} />
        </label>

        <label className={label}>
          {t("cite.authors")}
          <textarea
            className="min-h-[76px] resize-y rounded-lg border border-field bg-surface px-3 py-2.5 text-[15px] leading-normal text-ink outline-none focus:border-focus"
            rows={3}
            value={form.authors}
            onChange={set("authors")}
            placeholder={"Nguyễn, Văn A\nLeCun, Yann"}
          />
          <span className="text-[13px] leading-normal">{t("cite.authorsHint")}</span>
        </label>

        <div className="grid gap-3.5 sm:grid-cols-[minmax(0,180px)_minmax(0,1fr)]">
          <label className={label}>
            {t("cite.type")}
            <select className={`${field} pr-8`} value={form.type} onChange={set("type")}>
              {CITATION_TYPES.map((type) => (
                <option key={type} value={type}>
                  {t(TYPE_LABEL[type])}
                </option>
              ))}
            </select>
          </label>
          <label className={label}>
            {t("cite.container")}
            <input className={field} value={form.container} onChange={set("container")} maxLength={500} />
          </label>
        </div>

        <label className={label}>
          {t("cite.publisher")}
          <input className={field} value={form.publisher} onChange={set("publisher")} maxLength={300} />
        </label>

        <div className="grid grid-cols-2 gap-3.5 sm:grid-cols-4">
          <label className={label}>
            {t("cite.year")}
            <input className={field} value={form.year} onChange={set("year")} maxLength={4} inputMode="numeric" />
          </label>
          <label className={label}>
            {t("cite.volume")}
            <input className={field} value={form.volume} onChange={set("volume")} maxLength={50} />
          </label>
          <label className={label}>
            {t("cite.issue")}
            <input className={field} value={form.issue} onChange={set("issue")} maxLength={50} />
          </label>
          <label className={label}>
            {t("cite.pages")}
            <input className={field} value={form.pages} onChange={set("pages")} maxLength={50} placeholder="436-444" />
          </label>
        </div>

        {error && <Alert>{error}</Alert>}
        {notice && !error && <Alert tone="success">{notice}</Alert>}

        <div className="mt-1 flex flex-wrap items-center justify-end gap-2.5">
          <button type="button" className="btn-ghost h-11 basis-full justify-start px-3 text-sm text-accent-text sm:mr-auto sm:basis-auto" onClick={copy} disabled={busy}>
            <Icon name="copy" size={16} />
            {t("cite.copyBib")}
          </button>
          <button type="button" className="btn-outline" onClick={onClose} disabled={busy}>
            {t("common.cancel")}
          </button>
          <button type="submit" className="btn-primary" disabled={busy}>
            {t(update.isPending ? "common.saving" : "common.save")}
          </button>
        </div>
      </form>
    </dialog>
  );
}

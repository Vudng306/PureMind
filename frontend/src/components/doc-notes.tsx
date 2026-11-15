"use client";

import { useMemo, useRef, useState } from "react";

import { ApiError } from "@/lib/api";
import type { ChatCitation } from "@/lib/chat";
import { relativeTime } from "@/lib/doc-view";
import { useLang, useT, type Key } from "@/lib/i18n";
import { parseMarkdown } from "@/lib/markdown";
import { MSG } from "@/lib/messages";
import { MAX_NOTE_BODY, newId, splitNotes, useNoteActions, useNotes, type AiSource, type Note } from "@/lib/notes";
import { useUi } from "@/lib/ui-store";

import { AiBadge, Cite, CitedText } from "./cite";
import { Icon } from "./icons";
import { MarkdownView } from "./notebook-markdown";
import { ConfirmDialog } from "./ui";

export const AI_SOURCE_LABEL: Record<AiSource, Key> = {
  quick: "notes.fromQuick",
  deep: "notes.fromDeep",
  mindmap: "notes.fromMap",
  analysis: "notes.fromAnalysis",
  chat: "notes.fromChat",
  translation: "notes.fromTranslation",
};

function Counter({ length }: { length: number }) {
  const lang = useLang();
  if (length < MAX_NOTE_BODY - 1000) return null;
  return (
    <span className={`text-xs ${length >= MAX_NOTE_BODY ? "text-danger" : "text-muted"}`} aria-live="polite">
      {length.toLocaleString(lang)}/{MAX_NOTE_BODY.toLocaleString(lang)}
    </span>
  );
}

/** The text of a note. One kept from the AI still shows its [n] citations as links into the document. */
export function NoteBody({ note, onOpen }: { note: Note; onOpen: (c: ChatCitation) => void }) {
  const t = useT();
  const citations = note.provenance?.citations;
  const original = note.provenance?.source === "translation" ? note.provenance.quote : null;
  const chat = note.provenance?.source === "chat";
  const blocks = useMemo(() => (chat ? parseMarkdown(note.body) : null), [chat, note.body]);
  const sources = useMemo(() => new Map((citations ?? []).map((c) => [c.position, c])), [citations]);
  if (blocks) {
    // An answer from the chat was written as Markdown.
    return (
      <MarkdownView
        blocks={blocks}
        renderRef={(n) => <Cite n={n} sources={sources} onOpen={onOpen} />}
        className="text-[15px] leading-relaxed text-body [&_ol]:mb-2 [&_p]:mb-2 [&_ul]:mb-2"
      />
    );
  }
  const body = (
    <p className="whitespace-pre-wrap break-words text-[15px] leading-relaxed text-body">
      {citations?.length ? <CitedText text={note.body} citations={citations} onOpen={onOpen} /> : note.body}
    </p>
  );
  if (!original) return body;
  // A translation shows the passage it translates, unchanged, above it (AN-107).
  return (
    <div className="flex flex-col gap-2">
      <blockquote className="border-l-[3px] border-line pl-2.5 font-serif text-[14px] italic leading-relaxed text-muted">
        <span className="sr-only">{t("translate.original")}: </span>
        {original}
      </blockquote>
      {body}
    </div>
  );
}

/**
 * One note, the reader's own or one kept from the AI. Both can be edited and deleted; a note that came from
 * the AI keeps its badge and its source after an edit.
 */
export function NoteCard({ note, onOpen }: { note: Note; onOpen: (c: ChatCitation) => void }) {
  const t = useT();
  const lang = useLang();
  const showToast = useUi((s) => s.showToast);
  const { update, remove } = useNoteActions(note.document_id);
  const [draft, setDraft] = useState<string | null>(null); // null: not editing
  const [confirm, setConfirm] = useState(false);
  const fail = (e: unknown) => showToast(e instanceof ApiError ? e.message : MSG["MSG-23"]);
  const edited = note.updated_at !== note.created_at;

  function save() {
    const body = (draft ?? "").trim();
    if (!body) return setConfirm(true); // an emptied note is deleted, after asking
    if (body === note.body) return setDraft(null);
    update.mutate(
      { id: note.id, body },
      {
        onSuccess: () => {
          setDraft(null);
          showToast(t("panel.savedNote"));
        },
        onError: fail,
      },
    );
  }

  return (
    <article className="flex flex-col gap-2 rounded-xl border border-line p-3.5">
      <div className="flex min-h-8 items-center gap-2 text-xs text-muted">
        {note.origin === "ai_saved" && <AiBadge />}
        <span className="min-w-0 flex-1 truncate">
          {note.provenance ? `${t(AI_SOURCE_LABEL[note.provenance.source])} · ` : ""}
          {relativeTime(note.updated_at, lang)}
          {edited && note.origin === "ai_saved" ? ` · ${t("notes.edited")}` : ""}
        </span>
        {draft === null && (
          <>
            <button type="button" aria-label={t("notes.edit")} title={t("notes.edit")} onClick={() => setDraft(note.body)} className="icon-btn h-8 w-8 text-muted">
              <Icon name="pencil" size={15} />
            </button>
            <button type="button" aria-label={t("notes.delete")} title={t("notes.delete")} onClick={() => setConfirm(true)} className="icon-btn h-8 w-8 text-muted hover:text-danger">
              <Icon name="trash" size={15} />
            </button>
          </>
        )}
      </div>

      {draft === null ? (
        <NoteBody note={note} onOpen={onOpen} />
      ) : (
        <div className="flex flex-col gap-2">
          <textarea
            aria-label={t("notes.editAria")}
            autoFocus
            rows={Math.min(12, Math.max(3, draft.split("\n").length + 1))}
            value={draft}
            maxLength={MAX_NOTE_BODY}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) save();
              if (e.key === "Escape") setDraft(null);
            }}
            className="resize-y rounded-lg border border-accent bg-bg px-3 py-2.5 text-sm leading-normal text-ink outline-none"
          />
          <div className="flex items-center gap-2">
            <Counter length={draft.length} />
            <span className="flex-1" />
            <button type="button" onClick={() => setDraft(null)} className="h-[38px] px-2 text-sm text-muted hover:text-ink">
              {t("common.cancel")}
            </button>
            <button type="button" onClick={save} disabled={update.isPending} className="btn-primary h-[38px] rounded-lg px-4 text-sm">
              {t("common.save")}
            </button>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={confirm}
        title={t("notes.deleteQ")}
        confirmLabel={t("common.delete")}
        busy={remove.isPending}
        onCancel={() => setConfirm(false)}
        onConfirm={() =>
          remove.mutate(note.id, {
            onSuccess: () => showToast(t("panel.noteDeleted")),
            onError: fail,
            onSettled: () => setConfirm(false),
          })
        }
      >
        {t(note.origin === "ai_saved" ? "notes.deleteAiBody" : "notes.deleteBody")}
      </ConfirmDialog>
    </article>
  );
}

/** Where a new note is written. */
export function NoteComposer({ docId }: { docId: string }) {
  const t = useT();
  const showToast = useUi((s) => s.showToast);
  const { add } = useNoteActions(docId);
  const [draft, setDraft] = useState("");
  // One id per draft: a second press after a failure cannot make the note twice.
  const draftId = useRef<string | null>(null);

  function save() {
    const body = draft.trim();
    if (!body || add.isPending) return;
    draftId.current ??= newId();
    add.mutate({ id: draftId.current, body }, {
      onSuccess: () => {
        draftId.current = null;
        setDraft("");
        showToast(t("panel.savedNote"));
      },
      onError: (e) => showToast(e instanceof ApiError ? e.message : MSG["MSG-23"]),
    });
  }

  return (
    <div className="flex flex-col gap-2">
      <label className="sr-only" htmlFor={`note-new-${docId}`}>
        {t("notes.newAria")}
      </label>
      <textarea
        id={`note-new-${docId}`}
        rows={3}
        value={draft}
        maxLength={MAX_NOTE_BODY}
        placeholder={t("notes.placeholder")}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) save();
        }}
        className="resize-y rounded-[10px] border border-line bg-bg px-3.5 py-3 font-serif text-base leading-relaxed text-ink outline-none focus:border-focus"
      />
      <div className="flex items-center gap-2">
        <span className="text-xs text-muted">{draft.trim() ? t("panel.ctrlEnter") : ""}</span>
        <Counter length={draft.length} />
        <span className="flex-1" />
        <button type="button" onClick={save} disabled={!draft.trim() || add.isPending} className="btn-primary h-[38px] rounded-lg px-4 text-sm">
          <Icon name="plus" size={15} />
          {t("notes.add")}
        </button>
      </div>
    </div>
  );
}

/** The reader panel's notes: write one, then the reader's own notes and the ones kept from the AI. */
export function DocNotes({ docId, onOpen }: { docId: string; onOpen: (c: ChatCitation) => void }) {
  const t = useT();
  const lang = useLang();
  const { data: notes, isPending, isError, refetch } = useNotes(docId);
  const { own, ai } = splitNotes(notes ?? []);
  const newest = (list: Note[]) => [...list].sort((a, b) => b.created_at.localeCompare(a.created_at));

  return (
    <div className="flex flex-col gap-4">
      <NoteComposer docId={docId} />
      {isPending ? (
        <p className="text-sm text-muted">{t("common.loading")}</p>
      ) : isError ? (
        <p className="text-sm text-danger">
          {t("notes.loadFailed")}{" "}
          <button type="button" className="underline" onClick={() => void refetch()}>
            {t("common.retry")}
          </button>
        </p>
      ) : notes.length === 0 ? (
        <p className="px-3 py-5 text-center text-sm leading-normal text-muted">{t("notes.empty")}</p>
      ) : (
        <>
          {own.length > 0 && (
            <section className="flex flex-col gap-2.5">
              <h3 className="eyebrow">{t("notes.own").toLocaleUpperCase(lang)}</h3>
              {newest(own).map((n) => (
                <NoteCard key={n.id} note={n} onOpen={onOpen} />
              ))}
            </section>
          )}
          {ai.length > 0 && (
            <section className="flex flex-col gap-2.5">
              <h3 className="eyebrow">{t("notes.kept").toLocaleUpperCase(lang)}</h3>
              {newest(ai).map((n) => (
                <NoteCard key={n.id} note={n} onOpen={onOpen} />
              ))}
            </section>
          )}
        </>
      )}
    </div>
  );
}

"use client";

import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";

import { newId, notebookKey } from "./annotations";

export { newId };
import { api } from "./api";
import type { ChatCitation } from "./chat";

/** Notes on a document that are not tied to one highlight: the reader's own, and the ones kept from the AI. */

export const MAX_NOTE_BODY = 20_000;

export type AiSource = "quick" | "deep" | "mindmap" | "analysis" | "chat" | "translation";

/** Where a note kept from the AI came from, with the passages it cited when it was saved. */
export interface NoteProvenance {
  source: AiSource;
  /** Null for a translation, which is stored nowhere else. */
  source_id: string | null;
  part: string;
  /** A translation's passage, as it is in the document. */
  quote?: string | null;
  model: string | null;
  language: string | null;
  generated_at: string | null;
  citations: ChatCitation[];
}

export interface Note {
  id: string;
  document_id: string;
  body: string;
  origin: "user" | "ai_saved";
  provenance: NoteProvenance | null;
  created_at: string;
  updated_at: string;
}

export const notesKey = (docId: string) => ["notes", docId] as const;
export { notebookKey };

export function useNotes(docId: string, enabled = true) {
  return useQuery({ queryKey: notesKey(docId), queryFn: () => api<Note[]>(`/documents/${docId}/notes`), enabled });
}

function put(qc: QueryClient, note: Note) {
  qc.setQueryData<Note[]>(notesKey(note.document_id), (old) =>
    old ? (old.some((n) => n.id === note.id) ? old.map((n) => (n.id === note.id ? note : n)) : [...old, note]) : [note],
  );
  void qc.invalidateQueries({ queryKey: notebookKey });
}

/**
 * Write, edit and delete notes. A new note's id is chosen by the one writing it, once per draft (`newId`), so
 * sending the same draft again after a failure still makes one note (AN-105).
 */
export function useNoteActions(docId: string) {
  const qc = useQueryClient();
  const add = useMutation({
    mutationFn: ({ id, body }: { id: string; body: string }) =>
      api<Note>(`/documents/${docId}/notes`, { method: "POST", body: JSON.stringify({ id, body }) }),
    onSuccess: (note) => put(qc, note),
  });
  const update = useMutation({
    mutationFn: ({ id, body }: { id: string; body: string }) =>
      api<Note>(`/notes/${id}`, { method: "PATCH", body: JSON.stringify({ body }) }),
    onSuccess: (note) => put(qc, note),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api<void>(`/notes/${id}`, { method: "DELETE" }),
    onSuccess: (_, id) => {
      qc.setQueryData<Note[]>(notesKey(docId), (old) => old?.filter((n) => n.id !== id));
      void qc.invalidateQueries({ queryKey: notebookKey });
    },
  });
  return { add, update, remove };
}

export interface AiPiece {
  /** "artifact" for a summary or a mind map, "chat" for an answer. */
  source: "artifact" | "chat";
  source_id: string;
  /** Which piece: "all", "tldr", "takeaway:2", "findings:0", "question:1", "node:n4". */
  part: string;
}

/** Keep a piece of what the AI wrote. Only says which piece: the server reads the text from what it stored. */
export function useSaveAiNote() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (piece: AiPiece) => api<Note>("/notes/from-ai", { method: "POST", body: JSON.stringify(piece) }),
    onSuccess: (note) => put(qc, note),
  });
}

/** AN-107: keep a translation as a note, with the selected passage beside it; the document is not changed. */
export function useSaveTranslation(docId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (t: { quote: string; translation: string; target: "vi" | "en" }) =>
      api<Note>(`/documents/${docId}/notes/translation`, { method: "POST", body: JSON.stringify(t) }),
    onSuccess: (note) => put(qc, note),
  });
}

/** The note a piece was saved as, if it has been. */
export function savedAs(notes: Note[] | undefined, sourceId: string, part: string): Note | undefined {
  return notes?.find((n) => n.provenance?.source_id === sourceId && n.provenance.part === part);
}

/** The reader's own notes and the ones kept from the AI, each in the order given. */
export function splitNotes(notes: Note[]): { own: Note[]; ai: Note[] } {
  return { own: notes.filter((n) => n.origin === "user"), ai: notes.filter((n) => n.origin === "ai_saved") };
}

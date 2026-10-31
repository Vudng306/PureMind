import { api } from "./api";

export interface StudyItem {
  question: string;
  answer?: string;
  options: string[];
  correct?: number;
  source?: string;
}
export interface StudySet {
  id: string;
  document_id: string;
  title: string;
  kind: "flashcards" | "quiz";
  items: StudyItem[];
  progress: Record<string, { interval: number; due: string }>;
}
export interface Attempt {
  id: string;
  score: number;
  total: number;
  answers: number[];
  items: StudyItem[];
  created_at: string;
}
export const studyApi = {
  list: () => api<StudySet[]>("/study"),
  generate: (document_id: string, kind: StudySet["kind"], count: number, language: "vi" | "en") =>
    api<StudySet>("/study", { method: "POST", body: JSON.stringify({ document_id, kind, count, language }) }),
  remove: (id: string) => api<void>(`/study/${id}`, { method: "DELETE" }),
  submit: (id: string, answers: number[]) => api<Attempt>(`/study/${id}/attempts`, { method: "POST", body: JSON.stringify({ answers }) }),
  history: (id: string) => api<Attempt[]>(`/study/${id}/attempts`),
  review: (id: string, index: number, remembered: boolean) =>
    api<StudySet>(`/study/${id}/review`, { method: "POST", body: JSON.stringify({ index, remembered }) }),
};

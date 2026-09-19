"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";

import { MAX_HIGHLIGHT_NOTE, MAX_SELECTION, highlightsKey, toDto, type Highlight } from "@/lib/annotations";
import { api } from "@/lib/api";
import { documentsKey } from "@/lib/documents";
import { HIGHLIGHT_COLORS } from "@/lib/preferences";
import { useAccount } from "@/lib/queries";
import { useUi } from "@/lib/ui-store";

/** Highlights, notes and progress that older versions kept in this browser only. */
const LEGACY_KEY = "puremind-annotations";
const doneKey = (userId: string) => `puremind-annotations-imported:${userId}`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Older versions only had clean-text highlights, without category or PDF position. */
type LegacyHighlight = Omit<Highlight, "blockId" | "start" | "end" | "rects" | "category"> & {
  blockId: string;
  start: number;
  end: number;
};

interface Legacy {
  highlights: LegacyHighlight[];
  notes: Record<string, string>;
  progress: Record<string, number>;
}

interface ImportResult {
  highlights: number;
  notes: number;
  progress: number;
  unknown_documents: string[];
}

function readLegacy(): Legacy | null {
  try {
    const raw = localStorage.getItem(LEGACY_KEY);
    const state = raw ? JSON.parse(raw)?.state : null;
    if (!state) return null;
    return { highlights: state.highlights ?? [], notes: state.notes ?? {}, progress: state.progress ?? {} };
  } catch {
    return null;
  }
}

const isValid = (h: LegacyHighlight) =>
  UUID.test(h.docId) &&
  HIGHLIGHT_COLORS.includes(h.color) &&
  typeof h.blockId === "string" &&
  h.blockId.length > 0 &&
  h.blockId.length <= 64 &&
  Number.isInteger(h.start) &&
  h.start >= 0 &&
  Number.isInteger(h.end) &&
  h.end > h.start &&
  typeof h.text === "string" &&
  h.text.length > 0 &&
  h.text.length <= MAX_SELECTION;

/** Moves browser-local annotations to the signed-in account once; data for other accounts' documents stays. */
export function LocalDataImport() {
  const { data: user } = useAccount();
  const qc = useQueryClient();
  const started = useRef(false);

  useEffect(() => {
    if (!user || started.current) return;
    started.current = true;
    try {
      if (localStorage.getItem(doneKey(user.id))) return;
    } catch {
      return;
    }
    const legacy = readLegacy();
    const markDone = () => {
      try {
        localStorage.setItem(doneKey(user.id), new Date().toISOString());
      } catch {
        /* storage unavailable */
      }
    };
    if (!legacy) return markDone();

    const highlights = legacy.highlights.filter(isValid);
    const notes = Object.fromEntries(
      Object.entries(legacy.notes).filter(([id, t]) => UUID.test(id) && typeof t === "string" && t.trim()),
    );
    const progress = Object.fromEntries(
      Object.entries(legacy.progress).filter(([id, f]) => UUID.test(id) && typeof f === "number" && f >= 0 && f <= 1),
    );
    if (!highlights.length && !Object.keys(notes).length && !Object.keys(progress).length) {
      try {
        localStorage.removeItem(LEGACY_KEY);
      } catch {
        /* storage unavailable */
      }
      return markDone();
    }

    const body = {
      highlights: highlights.map((h) => ({
        ...toDto({ ...h, category: null, rects: null, note: (h.note ?? "").slice(0, MAX_HIGHLIGHT_NOTE), page: h.page ?? null }),
        id: UUID.test(h.id) ? h.id : null,
        created_at: h.createdAt,
      })),
      notes,
      progress,
    };

    api<ImportResult>("/annotations/import", { method: "POST", body: JSON.stringify(body) })
      .then((res) => {
        // Keep only what belongs to documents this account does not have (e.g. another account on this browser).
        const keep = new Set(res.unknown_documents);
        const rest: Legacy = {
          highlights: legacy.highlights.filter((h) => keep.has(h.docId)),
          notes: Object.fromEntries(Object.entries(legacy.notes).filter(([id]) => keep.has(id))),
          progress: Object.fromEntries(Object.entries(legacy.progress).filter(([id]) => keep.has(id))),
        };
        try {
          if (rest.highlights.length || Object.keys(rest.notes).length || Object.keys(rest.progress).length) {
            localStorage.setItem(LEGACY_KEY, JSON.stringify({ state: rest, version: 0 }));
          } else {
            localStorage.removeItem(LEGACY_KEY);
          }
        } catch {
          /* storage unavailable */
        }
        markDone();
        void qc.invalidateQueries({ queryKey: highlightsKey });
        void qc.invalidateQueries({ queryKey: documentsKey });
        if (res.highlights) {
          useUi.getState().showToast(`Đã chuyển ${res.highlights} highlight từ trình duyệt này lên tài khoản`);
        }
      })
      .catch(() => {
        started.current = false; // try again on the next visit
      });
  }, [user, qc]);

  return null;
}

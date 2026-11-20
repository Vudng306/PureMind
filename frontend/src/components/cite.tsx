"use client";

import { citationLabel, type ChatCitation } from "@/lib/chat";
import { useLang, useT } from "@/lib/i18n";
import { savedAs, useNotes, useSaveAiNote, type AiPiece } from "@/lib/notes";
import { isPartial, shownIssues } from "@/lib/reading";
import type { ExtractionIssue } from "@/lib/types";
import { useUi } from "@/lib/ui-store";

import { Icon } from "./icons";

/**
 * A [n] citation: opens the passage in the document. A number with no passage behind it is shown plain and
 * says so (AI-105): it opens nothing rather than somewhere near.
 */
export function Cite({
  n,
  sources,
  onOpen,
}: {
  n: number;
  sources: Map<number, ChatCitation>;
  onOpen: (c: ChatCitation) => void;
}) {
  const t = useT();
  const lang = useLang();
  const cls = "mx-px rounded px-1 py-px align-[0.1em] font-sans text-[0.72em] font-semibold";
  const source = sources.get(n);
  if (!source) {
    return (
      <span
        className={`${cls} bg-soft text-muted underline decoration-dotted underline-offset-2`}
        title={t("ai.sourceMissing")}
        aria-label={t("ai.sourceMissingN", { n })}
      >
        {n}
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={() => onOpen(source)}
      // On a phone the small number takes a finger: its touch area reaches past it without moving the text.
      className={`${cls} bg-accent/15 text-accent-text hover:bg-accent/25 max-md:relative max-md:after:absolute max-md:after:-inset-x-1 max-md:after:-inset-y-3`}
      title={`${citationLabel(source, lang)}: “${source.text.slice(0, 120)}”`}
      aria-label={t("chat.sourceN", { n, where: citationLabel(source, lang) })}
    >
      {n}
    </button>
  );
}

/** The citations of one point, after its text. */
export function Cites({
  ns,
  sources,
  onOpen,
}: {
  ns: number[];
  sources: Map<number, ChatCitation>;
  onOpen: (c: ChatCitation) => void;
}) {
  if (ns.length === 0) return null;
  return (
    <span className="whitespace-nowrap">
      {" "}
      {ns.map((n) => (
        <Cite key={n} n={n} sources={sources} onOpen={onOpen} />
      ))}
    </span>
  );
}

/** Text that may carry [n] markers (a note kept from the AI): each marker with a passage becomes a citation. */
export function CitedText({
  text,
  citations,
  onOpen,
}: {
  text: string;
  citations: ChatCitation[];
  onOpen: (c: ChatCitation) => void;
}) {
  const sources = new Map(citations.map((c) => [c.position, c]));
  const parts = text.split(/(\[\d{1,3}\])/g);
  return (
    <>
      {parts.map((part, i) => {
        const m = /^\[(\d{1,3})\]$/.exec(part);
        return m && sources.has(Number(m[1])) ? (
          <Cite key={i} n={Number(m[1])} sources={sources} onOpen={onOpen} />
        ) : (
          <span key={i}>{part}</span>
        );
      })}
    </>
  );
}

/**
 * "Save to notes": the only way something the AI wrote gets into the notebook. It names the piece; the
 * server takes the text from what it stored. A piece already saved shows as saved and cannot be saved twice.
 */
export function SaveToNotes({
  docId,
  piece,
  compact = false,
  className = "",
}: {
  docId: string;
  piece: AiPiece;
  /** Icon only, for a button that sits beside one point. */
  compact?: boolean;
  className?: string;
}) {
  const t = useT();
  const showToast = useUi((s) => s.showToast);
  const { data: notes } = useNotes(docId);
  const save = useSaveAiNote();
  const saved = Boolean(savedAs(notes, piece.source_id, piece.part));
  const label = t(saved ? "ai.saved" : "ai.save");

  function run() {
    if (saved || save.isPending) return;
    save.mutate(piece, {
      onSuccess: () => showToast(t("ai.savedToast")),
      onError: (e) => showToast(e instanceof Error ? e.message : t("ai.saveFailed")),
    });
  }

  if (compact) {
    return (
      <button
        type="button"
        onClick={run}
        disabled={saved || save.isPending}
        aria-label={label}
        title={label}
        className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg max-md:h-11 max-md:w-11 ${
          saved ? "text-success" : "text-muted hover:bg-soft hover:text-ink"
        } ${className}`}
      >
        <Icon name={saved ? "check" : "bookmark"} size={15} />
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={run}
      disabled={saved || save.isPending}
      className={`flex h-8 items-center gap-1.5 rounded-lg px-2 text-[13px] font-medium max-md:h-11 ${
        saved ? "text-success" : "text-accent-text hover:bg-soft"
      } ${className}`}
    >
      <Icon name={saved ? "check" : "bookmark"} size={15} />
      {label}
    </button>
  );
}

/**
 * TSD 6.1: what the AI read is the extracted text, so when part of the document is not in it (scanned pages,
 * tables or equations as pictures) or was read by OCR, a summary or an answer says so next to it.
 */
export function AiCoverage({ issues }: { issues: ExtractionIssue[] | null | undefined }) {
  const t = useT();
  if (!shownIssues(issues).length) return null;
  return (
    <p role="note" className="rounded-lg bg-soft px-3 py-2.5 text-[13px] leading-normal text-body">
      {t(isPartial(issues) ? "ai.coveragePartial" : "ai.coverageOcr")}
    </p>
  );
}

/** Marks text the AI wrote, wherever it is shown. */
export function AiBadge({ label }: { label?: string }) {
  const t = useT();
  return (
    <span className="inline-flex h-5 items-center gap-1 rounded-full bg-accent/15 px-1.5 text-[11px] font-semibold text-accent-text">
      <Icon name="spark" size={11} />
      {label ?? t("ai.badge")}
    </span>
  );
}

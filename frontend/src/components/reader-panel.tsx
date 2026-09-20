"use client";

import { useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import {
  CATEGORY_FOR_COLOR,
  MAX_HIGHLIGHT_NOTE,
  saveDocumentNote,
  useHighlightActions,
  type Highlight,
} from "@/lib/annotations";
import { useDocument } from "@/lib/documents";
import { MSG } from "@/lib/messages";
import { notebooksUsing } from "@/lib/notebooks";
import { COLOR_DOT, HIGHLIGHT_COLORS, colorLabel, usePreferences, type HighlightColor } from "@/lib/preferences";
import { useUi } from "@/lib/ui-store";

import { Icon } from "./icons";
import { SummaryPanel } from "./summary-panel";
import { ConfirmDialog } from "./ui";

export type PanelTab = "highlights" | "notes" | "ai";

function HighlightCard({
  h,
  active,
  editing,
  lost,
  onJump,
  onEdit,
  onDone,
}: {
  h: Highlight;
  active: boolean;
  editing: boolean;
  lost: boolean;
  onJump: () => void;
  onEdit: () => void;
  onDone: () => void;
}) {
  const labels = usePreferences((s) => s.colorLabels);
  const showToast = useUi((s) => s.showToast);
  const { updateHighlight, removeHighlight } = useHighlightActions();
  const ref = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState(h.note);
  const opened = useRef(h.note);
  const [confirm, setConfirm] = useState<"note" | "highlight" | null>(null);
  const [usedIn, setUsedIn] = useState(0);

  useEffect(() => {
    if (active) ref.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [active]);

  useEffect(() => {
    if (!editing) return;
    setDraft(h.note);
    opened.current = h.note;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);

  function onDraft(text: string) {
    setDraft(text);
    // An emptied note is only removed after confirmation (FR-NOTE-01).
    if (text.trim()) updateHighlight(h.id, { note: text });
  }

  function finish() {
    if (!draft.trim()) {
      if (h.note.trim()) return setConfirm("note");
      return onDone();
    }
    if (draft !== opened.current) {
      updateHighlight(h.id, { note: draft }, { now: true });
      showToast("Đã lưu ghi chú");
    }
    onDone();
  }

  async function remove() {
    // FR-HL-03: confirm when the highlight has a note or is a source of a notebook.
    let used = 0;
    try {
      used = (await notebooksUsing(h.id)).length;
    } catch {
      /* not known (offline or not saved yet): only the note decides */
    }
    setUsedIn(used);
    if (h.note.trim() || used) return setConfirm("highlight");
    removeHighlight(h.id);
    showToast("Đã xóa highlight");
  }

  return (
    <div
      ref={ref}
      className={`flex flex-col gap-2.5 rounded-xl border p-3.5 transition-colors ${active ? "border-accent" : "border-line"}`}
    >
      <div className="flex items-center gap-2 text-xs text-muted">
        <span className="flex h-6 items-center gap-1.5 rounded-full bg-soft pl-1.5 pr-2 text-xs font-semibold text-ink">
          <span className="h-2.5 w-2.5 rounded-full" style={{ background: COLOR_DOT[h.color] }} />
          {colorLabel(labels, h.color)}
        </span>
        {h.page ? `Trang ${h.page}` : null}
        <span className="flex-1" />
        {HIGHLIGHT_COLORS.map((c) => (
          <button
            key={c}
            type="button"
            aria-label={`Đổi thành ${colorLabel(labels, c)}`}
            title={colorLabel(labels, c)}
            aria-pressed={c === h.color}
            // The color is the category: picking one says what the passage is (FR-HL-04).
            onClick={() => updateHighlight(h.id, { color: c, category: CATEGORY_FOR_COLOR[c] })}
            className="flex h-9 w-[20px] items-center justify-center"
          >
            <span
              className="h-3 w-3 rounded-full"
              style={{
                background: COLOR_DOT[c],
                boxShadow: c === h.color ? "0 0 0 2px rgb(var(--surface)), 0 0 0 3.5px rgb(var(--ink))" : undefined,
              }}
            />
          </button>
        ))}
        <button
          type="button"
          aria-label="Xóa highlight"
          onClick={() => void remove()}
          className="flex h-9 w-9 items-center justify-center rounded-lg text-muted hover:bg-soft hover:text-danger"
        >
          <Icon name="trash" size={16} />
        </button>
      </div>
      <button type="button" onClick={onJump} className="text-left font-serif text-base leading-normal text-ink hover:underline">
        “{h.text}”
      </button>
      {lost &&
        (h.rects ? (
          <p className="rounded-lg bg-soft px-3 py-2 text-xs leading-normal text-muted">
            Highlight tạo trên Bản gốc — chưa tìm thấy đoạn này trong Văn bản sạch. Bấm vào đoạn trích để xem trên bản gốc.
          </p>
        ) : (
          <p className="rounded-lg bg-danger-soft px-3 py-2 text-xs leading-normal text-danger">
            Không định vị được đoạn này — nội dung tài liệu đã thay đổi. Highlight và ghi chú vẫn được giữ.
          </p>
        ))}
      {editing ? (
        <div className="flex flex-col gap-2">
          <textarea
            aria-label="Ghi chú cho highlight"
            autoFocus
            rows={3}
            value={draft}
            maxLength={MAX_HIGHLIGHT_NOTE}
            placeholder="Vì sao đoạn này quan trọng?"
            onChange={(e) => onDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) finish();
            }}
            className="resize-y rounded-lg border border-accent bg-bg px-3 py-2.5 text-sm leading-normal text-ink outline-none"
          />
          <div className="flex items-center gap-2">
            <span className={`text-xs ${draft.length >= MAX_HIGHLIGHT_NOTE ? "text-danger" : "text-muted"}`} aria-live="polite">
              {draft.length >= MAX_HIGHLIGHT_NOTE
                ? MSG["MSG-24"]
                : draft.length > MAX_HIGHLIGHT_NOTE - 1000
                  ? `${draft.length.toLocaleString("vi-VN")}/${MAX_HIGHLIGHT_NOTE.toLocaleString("vi-VN")}`
                  : "Ctrl+Enter để lưu"}
            </span>
            <span className="flex-1" />
            {h.note.trim() && (
              <button type="button" onClick={() => setConfirm("note")} className="h-[38px] px-2 text-sm text-muted hover:text-danger">
                Xóa ghi chú
              </button>
            )}
            <button type="button" onClick={finish} className="btn-primary h-[38px] rounded-lg px-4 text-sm">
              Xong
            </button>
          </div>
        </div>
      ) : h.note ? (
        <button type="button" onClick={onEdit} className="whitespace-pre-wrap rounded-lg bg-soft px-3 py-2.5 text-left text-sm leading-normal text-body">
          {h.note}
        </button>
      ) : (
        <button type="button" onClick={onEdit} className="h-9 self-start text-sm font-medium text-accent hover:underline">
          + Thêm ghi chú
        </button>
      )}
      <ConfirmDialog
        open={confirm !== null}
        title={confirm === "note" ? "Xóa ghi chú?" : "Xóa highlight?"}
        confirmLabel="Xóa"
        onCancel={() => {
          if (confirm === "note") setDraft(h.note);
          setConfirm(null);
        }}
        onConfirm={() => {
          if (confirm === "note") {
            updateHighlight(h.id, { note: "" }, { now: true });
            setDraft("");
            showToast("Đã xóa ghi chú");
            onDone();
          } else {
            removeHighlight(h.id);
            showToast(h.note.trim() ? "Đã xóa highlight và ghi chú" : "Đã xóa highlight");
          }
          setConfirm(null);
        }}
      >
        {confirm === "note" ? (
          "Ghi chú của highlight này sẽ bị xóa. Đoạn highlight vẫn được giữ."
        ) : (
          <>
            {h.note.trim() && <p>Highlight này có ghi chú. Xóa highlight sẽ xóa luôn ghi chú đi kèm.</p>}
            {usedIn > 0 && (
              <p className={h.note.trim() ? "mt-2" : ""}>
                Highlight đang là nguồn của {usedIn} notebook. Notebook vẫn được giữ, nhưng trích dẫn tới đoạn này sẽ
                hiện “Nguồn đã bị xóa”.
              </p>
            )}
          </>
        )}
      </ConfirmDialog>
    </div>
  );
}

/** Right panel: highlights filtered by meaning, document note, AI summary. */
export function ReaderPanel({
  docId,
  highlights,
  tab,
  onTab,
  onClose,
  activeId,
  editingId,
  onEditing,
  onJump,
  aiQuote,
  onKeyword,
  canHighlight,
  lostIds,
}: {
  docId: string;
  highlights: Highlight[];
  tab: PanelTab;
  onTab: (tab: PanelTab) => void;
  onClose: () => void;
  activeId: string | null;
  editingId: string | null;
  onEditing: (id: string | null) => void;
  onJump: (h: Highlight) => void;
  aiQuote: string | null;
  /** A summary keyword was chosen: find it in the document (FR-SUM-01 output). */
  onKeyword: (keyword: string) => void;
  canHighlight: boolean;
  /** Highlights that could not be placed in the current text (FR-HL-02). */
  lostIds: string[];
}) {
  const labels = usePreferences((s) => s.colorLabels);
  const qc = useQueryClient();
  const { data: doc } = useDocument(docId);
  const [filter, setFilter] = useState<HighlightColor | "all">("all");
  const [draft, setDraft] = useState(doc?.note ?? "");
  const [status, setStatus] = useState<"saved" | "dirty" | "saving" | "error">("saved");
  const sent = useRef(doc?.note ?? "");

  async function saveNote(text: string) {
    if (text === sent.current) return setStatus("saved");
    setStatus("saving");
    try {
      await saveDocumentNote(qc, docId, text);
      sent.current = text;
      setStatus((s) => (s === "saving" ? "saved" : s));
    } catch {
      setStatus("error");
    }
  }

  // Unsaved text is still sent when the panel closes.
  const latest = useRef(draft);
  latest.current = draft;
  useEffect(
    () => () => {
      if (latest.current !== sent.current) saveDocumentNote(qc, docId, latest.current).catch(() => undefined);
    },
    [qc, docId],
  );

  // Document note autosaves shortly after typing stops.
  useEffect(() => {
    if (status !== "dirty") return;
    const t = setTimeout(() => void saveNote(draft), 800);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, status]);

  const sorted = [...highlights].sort((a, b) => (a.page ?? 0) - (b.page ?? 0) || a.createdAt.localeCompare(b.createdAt));
  // Filtering by color is filtering by category: the two are the same choice (CATEGORY_FOR_COLOR).
  const shown = sorted.filter((h) => filter === "all" || h.color === filter);
  const lost = new Set(lostIds);
  const lostText = highlights.filter((h) => lost.has(h.id) && !h.rects).length;
  const tabs: [PanelTab, string][] = [
    ["highlights", `Highlight · ${highlights.length}`],
    ["notes", "Ghi chú"],
    ["ai", "Tóm tắt AI"],
  ];

  return (
    <aside
      aria-label="Highlight và ghi chú"
      className="fixed inset-y-0 right-0 z-20 flex w-full min-h-0 flex-col border-l border-line bg-surface shadow-pop sm:w-[380px] lg:static lg:z-auto lg:shadow-none"
    >
      <div className="flex h-[60px] shrink-0 items-center gap-1 border-b border-line pl-3 pr-2" role="tablist">
        {tabs.map(([value, label]) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={tab === value}
            onClick={() => onTab(value)}
            className={`h-10 rounded-[9px] px-3 text-sm ${tab === value ? "bg-soft font-semibold text-ink" : "text-muted hover:text-ink"}`}
          >
            {label}
          </button>
        ))}
        <span className="flex-1" />
        <button type="button" aria-label="Đóng bảng" onClick={onClose} className="icon-btn text-muted">
          <Icon name="x" />
        </button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
        {tab === "highlights" && (
          <>
            {highlights.length > 0 && (
              <Link
                href={`/notebooks/new?document=${docId}`}
                className="flex items-center gap-2 rounded-lg border border-line px-3 py-2.5 text-sm font-medium text-ink transition-colors hover:bg-soft"
              >
                <Icon name="spark" size={16} className="text-accent" />
                <span className="flex-1">Tạo notebook AI từ các highlight này</span>
                <Icon name="next" size={16} className="text-muted" />
              </Link>
            )}
            {highlights.length > 0 && (
              <div aria-label="Lọc theo ý nghĩa màu" className="flex flex-wrap gap-1.5">
                <button type="button" aria-pressed={filter === "all"} onClick={() => setFilter("all")} className="chip h-[34px] px-2.5 text-[13px]">
                  Tất cả · {highlights.length}
                </button>
                {HIGHLIGHT_COLORS.map((c) => {
                  const count = highlights.filter((h) => h.color === c).length;
                  return (
                    <button
                      key={c}
                      type="button"
                      aria-pressed={filter === c}
                      onClick={() => setFilter(filter === c ? "all" : c)}
                      className="chip h-[34px] gap-1.5 px-2.5 text-[13px]"
                    >
                      <span className="h-2.5 w-2.5 rounded-full" style={{ background: COLOR_DOT[c] }} />
                      {colorLabel(labels, c)} · {count}
                    </button>
                  );
                })}
              </div>
            )}
            {lostText > 0 && (
              <p className="rounded-lg bg-soft px-3 py-2.5 text-[13px] leading-normal text-muted">
                {lostText} highlight không định vị được trong nội dung hiện tại.
              </p>
            )}
            {!canHighlight && (
              <p className="rounded-lg bg-soft px-3 py-2.5 text-[13px] leading-normal text-muted">
                Highlight hoạt động ở chế độ Văn bản sạch.
              </p>
            )}
            {highlights.length === 0 ? (
              <p className="px-3 py-7 text-center text-sm leading-normal text-muted">
                Chưa có highlight. Bôi đen một câu trong bài để bắt đầu.
              </p>
            ) : shown.length === 0 ? (
              <p className="px-3 py-5 text-center text-sm leading-normal text-muted">
                Không có highlight nào khớp bộ lọc trong tài liệu này.
              </p>
            ) : (
              shown.map((h) => (
                <HighlightCard
                  key={h.id}
                  h={h}
                  active={h.id === activeId}
                  editing={h.id === editingId}
                  lost={lost.has(h.id)}
                  onJump={() => onJump(h)}
                  onEdit={() => onEditing(h.id)}
                  onDone={() => onEditing(null)}
                />
              ))
            )}
          </>
        )}

        {tab === "notes" && (
          <div className="flex flex-1 flex-col gap-2">
            <label className="flex flex-1 flex-col gap-2 text-sm font-medium text-ink">
              Ghi chú cho tài liệu này
              <textarea
                value={draft}
                maxLength={20000}
                onChange={(e) => {
                  setDraft(e.target.value);
                  setStatus("dirty");
                }}
                onBlur={() => void saveNote(draft)}
                placeholder="Viết suy nghĩ, câu hỏi, việc cần ôn…"
                className="min-h-[320px] flex-1 resize-none rounded-[10px] border border-line bg-bg px-3.5 py-3 font-serif text-base font-normal leading-relaxed text-ink outline-none focus:border-accent"
              />
            </label>
            <span className={`text-xs ${status === "error" ? "text-danger" : "text-muted"}`} aria-live="polite">
              {draft.length} ký tự ·{" "}
              {status === "saved" ? "Đã lưu" : status === "error" ? (
                <button type="button" className="underline" onClick={() => void saveNote(draft)}>
                  Chưa lưu được — thử lại
                </button>
              ) : (
                "Đang lưu…"
              )}
            </span>
          </div>
        )}

        {tab === "ai" && (
          <div className="flex flex-col gap-5">
            {aiQuote && (
              <div className="flex flex-col gap-2.5 rounded-xl border border-line p-3.5">
                <span className="text-xs text-muted">Đoạn đang hỏi</span>
                <span className="font-serif text-[15px] leading-normal text-ink">“{aiQuote}”</span>
                <span className="rounded-lg bg-soft px-3 py-2.5 text-sm text-muted">
                  Giải thích một đoạn bằng AI chưa có trong phiên bản này. Bạn có thể tạo tóm tắt cả tài liệu bên dưới.
                </span>
              </div>
            )}
            <SummaryPanel docId={docId} onKeyword={onKeyword} />
          </div>
        )}
      </div>
    </aside>
  );
}

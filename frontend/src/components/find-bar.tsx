"use client";

import { useEffect, useRef } from "react";

import { supportsHighlights } from "@/lib/find";

import { Icon } from "./icons";

/** FR-RDR-04 floating search bar: Enter / Shift+Enter move between results, Esc closes. */
export function FindBar({
  query,
  onQuery,
  index,
  total,
  onIndex,
  onClose,
}: {
  query: string;
  onQuery: (q: string) => void;
  index: number;
  total: number;
  onIndex: (i: number) => void;
  onClose: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const hasQuery = query.trim().length > 0;
  const position = total ? (((index % total) + total) % total) + 1 : 0;
  const step = (delta: number) => total && onIndex(index + delta);

  return (
    <div
      role="search"
      className="absolute left-1/2 top-3 z-20 flex h-14 w-[min(500px,calc(100%-24px))] -translate-x-1/2 items-center gap-1.5 rounded-[14px] border border-line bg-surface pl-4 pr-1.5 text-muted shadow-float"
    >
      <Icon name="search" />
      <label htmlFor="find-input" className="sr-only">
        Tìm trong tài liệu
      </label>
      <input
        ref={inputRef}
        id="find-input"
        className="ml-1 min-w-0 flex-1 bg-transparent text-base text-ink outline-none"
        placeholder="Tìm trong tài liệu"
        value={query}
        maxLength={200}
        onChange={(e) => onQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            step(e.shiftKey ? -1 : 1);
          } else if (e.key === "Escape") {
            e.preventDefault();
            onClose();
          }
        }}
      />
      <span className="whitespace-nowrap text-[13px]" aria-live="polite" title={!supportsHighlights() ? "Trình duyệt không hỗ trợ tô sáng kết quả." : undefined}>
        {hasQuery ? (total ? `${position} / ${total}` : "0 kết quả") : ""}
      </span>
      <button type="button" className="icon-btn h-10 w-10 text-muted" onClick={() => step(-1)} disabled={!total} aria-label="Kết quả trước">
        <Icon name="up" />
      </button>
      <button type="button" className="icon-btn h-10 w-10 text-muted" onClick={() => step(1)} disabled={!total} aria-label="Kết quả sau">
        <Icon name="down" />
      </button>
      <button type="button" className="icon-btn h-10 w-10 text-muted" onClick={onClose} aria-label="Đóng tìm kiếm">
        <Icon name="x" />
      </button>
    </div>
  );
}

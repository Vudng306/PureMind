"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";

import { useHighlights } from "@/lib/annotations";
import { KIND_CLASS, KIND_LABEL, isProcessing, origin, progressLabel, progressOf } from "@/lib/doc-view";
import { useDocuments } from "@/lib/documents";
import { normalize } from "@/lib/find";
import { COLOR_DOT, colorLabel, usePreferences } from "@/lib/preferences";
import type { Theme } from "@/lib/types";
import { useUi } from "@/lib/ui-store";

import { Icon, type IconName } from "./icons";
import { useModal } from "./ui";

type Item =
  | { kind: "doc"; key: string; run: () => void; node: React.ReactNode }
  | { kind: "hl"; key: string; run: () => void; node: React.ReactNode }
  | { kind: "action"; key: string; run: () => void; node: React.ReactNode };

const THEME_NAME: Record<Theme, string> = { light: "sáng", sepia: "giấy cũ", dark: "tối" };

/** Ctrl+K quick search over documents, highlights and common actions. */
export function CommandPalette() {
  const router = useRouter();
  const pathname = usePathname();
  const { paletteOpen, setPaletteOpen, setAddOpen, showToast } = useUi();
  const ref = useModal(paletteOpen);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const { data: docs } = useDocuments("created_desc");
  const { data: highlights } = useHighlights();
  const { colorLabels, set: setPrefs } = usePreferences();

  useEffect(() => {
    if (!paletteOpen) return;
    setQuery("");
    setCursor(0);
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [paletteOpen]);

  useEffect(() => setPaletteOpen(false), [pathname, setPaletteOpen]);

  const close = () => setPaletteOpen(false);
  const q = normalize(query.trim());

  const items = useMemo<Item[]>(() => {
    const out: Item[] = [];
    const titleOf = new Map((docs ?? []).map((d) => [d.id, d.title]));

    const docHits = (docs ?? []).filter((d) => !q || normalize(`${d.title} ${origin(d)}`).includes(q)).slice(0, q ? 8 : 5);
    for (const d of docHits) {
      const pct = progressOf(d);
      out.push({
        kind: "doc",
        key: `d-${d.id}`,
        run: () => router.push(`/reader/${d.id}`),
        node: (
          <>
            <span className={`flex h-6 w-11 shrink-0 items-center justify-center rounded-[5px] text-[11px] font-bold ${KIND_CLASS[d.file_type]}`}>
              {KIND_LABEL[d.file_type]}
            </span>
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="truncate text-[15px] font-medium">{d.title}</span>
              <span className="truncate text-xs text-muted">
                {origin(d)} · {progressLabel(d, pct)}
              </span>
            </span>
            {isProcessing(d) && <span className="text-xs text-muted">Đang xử lý…</span>}
          </>
        ),
      });
    }

    if (q) {
      const hlHits = highlights
        .filter((h) => titleOf.has(h.docId) && normalize(`${h.text} ${h.note}`).includes(q))
        .slice(0, 6);
      for (const h of hlHits) {
        out.push({
          kind: "hl",
          key: `h-${h.id}`,
          run: () => router.push(`/reader/${h.docId}?hl=${h.id}`),
          node: (
            <>
              <span className="mx-[17px] h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: COLOR_DOT[h.color] }} />
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="truncate font-serif text-[15px]">“{h.text}”</span>
                <span className="truncate text-xs text-muted">
                  {colorLabel(colorLabels, h.color)} · {titleOf.get(h.docId)}
                  {h.page ? ` · trang ${h.page}` : ""}
                </span>
              </span>
            </>
          ),
        });
      }
    }

    const typed = query.trim();
    const actions: { key: string; icon: IconName; label: string; run: () => void }[] = [
      ...(typed.length >= 2
        ? [
            {
              key: "search-all",
              icon: "search" as IconName,
              label: `Tìm “${typed}” trong toàn bộ tài liệu, highlight và ghi chú`,
              run: () => router.push(`/search?q=${encodeURIComponent(typed)}`),
            },
          ]
        : []),
      { key: "add", icon: "plus", label: "Thêm tài liệu (tệp hoặc link)", run: () => setAddOpen(true) },
      { key: "highlights", icon: "highlighter", label: "Xem tất cả highlight", run: () => router.push("/highlights") },
      { key: "notebooks", icon: "note", label: "Xem notebook", run: () => router.push("/notebooks") },
      { key: "notebook-new", icon: "spark", label: "Tạo notebook AI từ highlight", run: () => router.push("/notebooks/new") },
      { key: "settings", icon: "gear", label: "Cài đặt đọc", run: () => router.push("/settings") },
      ...(["light", "sepia", "dark"] as Theme[]).map((t) => ({
        key: `theme-${t}`,
        icon: "spark" as IconName,
        label: `Đổi sang nền ${THEME_NAME[t]}`,
        run: () => {
          setPrefs({ theme: t });
          showToast(`Đã đổi sang nền ${THEME_NAME[t]}`);
        },
      })),
    ];
    for (const a of actions) {
      if (q && a.key !== "search-all" && !normalize(a.label).includes(q)) continue;
      out.push({
        kind: "action",
        key: a.key,
        run: a.run,
        node: (
          <>
            <span className="flex w-11 justify-center text-accent">
              <Icon name={a.icon} />
            </span>
            <span className="text-[15px]">{a.label}</span>
          </>
        ),
      });
    }
    return out;
  }, [docs, highlights, q, query, colorLabels, router, setAddOpen, setPrefs, showToast]);

  const active = Math.min(cursor, Math.max(0, items.length - 1));

  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  function run(item: Item | undefined) {
    if (!item) return;
    if (item.kind !== "action" || !item.key.startsWith("theme-")) close();
    item.run();
  }

  const heading = (label: string) => <div className="px-3 pb-1.5 pt-3 text-xs font-semibold tracking-[0.08em] text-muted">{label}</div>;
  const hasDocs = items.some((i) => i.kind === "doc");
  const hasHls = items.some((i) => i.kind === "hl");

  return (
    <dialog
      ref={ref}
      aria-label="Tìm nhanh"
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
      onClick={(e) => e.target === e.currentTarget && close()}
      className="dialog mt-[max(16px,11vh)] w-[min(calc(100vw-32px),640px)] overflow-hidden"
    >
      <div className="flex h-16 items-center gap-3 border-b border-line pl-5 pr-2 text-muted">
        <Icon name="search" size={20} />
        <input
          ref={inputRef}
          aria-label="Tìm tài liệu, highlight hoặc thao tác"
          placeholder="Tìm tài liệu, highlight hoặc thao tác…"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setCursor(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setCursor((c) => Math.min(items.length - 1, c + 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setCursor((c) => Math.max(0, c - 1));
            } else if (e.key === "Enter") {
              e.preventDefault();
              run(items[active]);
            }
          }}
          className="min-w-0 flex-1 bg-transparent text-lg text-ink outline-none"
        />
        <button type="button" onClick={close} className="btn-ghost h-11 px-3 text-[13px] text-muted">
          Đóng
        </button>
      </div>
      <div ref={listRef} className="flex max-h-[min(470px,60vh)] flex-col gap-0.5 overflow-y-auto p-2" role="listbox" aria-label="Kết quả">
        {items.map((item, i) => (
          <div key={item.key} className="contents">
            {i === 0 && hasDocs && heading("TÀI LIỆU")}
            {item.kind === "hl" && items[i - 1]?.kind !== "hl" && heading("TRONG HIGHLIGHT")}
            {item.kind === "action" && items[i - 1]?.kind !== "action" && (
              <>
                {q && !hasDocs && !hasHls && (
                  <p className="px-3 py-5 text-sm text-muted">Không tìm thấy “{query.trim()}” trong tài liệu hay highlight.</p>
                )}
                {heading("THAO TÁC")}
              </>
            )}
            <button
              type="button"
              role="option"
              aria-selected={i === active}
              data-index={i}
              onMouseMove={() => setCursor(i)}
              onClick={() => run(item)}
              className={`flex min-h-12 items-center gap-3 rounded-[10px] px-3 py-1.5 text-left text-ink ${i === active ? "bg-soft" : ""}`}
            >
              {item.node}
            </button>
          </div>
        ))}
        {items.length === 0 && <p className="px-3 py-5 text-sm text-muted">Không tìm thấy “{query.trim()}”.</p>}
      </div>
    </dialog>
  );
}

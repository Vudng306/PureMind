"use client";

import { useEffect, useState } from "react";

import { AccountSettings } from "@/components/account-settings";
import { Icon } from "@/components/icons";
import {
  COLOR_DOT,
  COLOR_NAME,
  DEFAULT_COLOR_LABELS,
  HIGHLIGHT_COLORS,
  MAX_COLOR_LABEL,
  colorLabel,
  usePreferences,
  type ColumnWidth,
  type HighlightColor,
  type LineHeight,
  type OpenMode,
} from "@/lib/preferences";
import type { Theme } from "@/lib/types";
import { useUi } from "@/lib/ui-store";

const THEMES: [Theme, string][] = [
  ["light", "Sáng"],
  ["sepia", "Giấy cũ"],
  ["dark", "Tối"],
];
const LINE_HEIGHTS: [LineHeight, string][] = [
  [1.5, "Gọn"],
  [1.65, "Vừa"],
  [1.8, "Thoáng"],
];
const WIDTHS: [ColumnWidth, string][] = [
  [600, "Hẹp"],
  [680, "Vừa"],
  [780, "Rộng"],
];
const MODES: [OpenMode, string][] = [
  ["clean", "Văn bản sạch"],
  ["original", "Bản gốc"],
];

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <span className="text-[15px] font-medium">{label}</span>
      <div className="flex flex-wrap items-center gap-1.5" role="radiogroup" aria-label={label}>
        {children}
      </div>
    </div>
  );
}

/** UI-10 / UI-11: reader defaults, highlight color meanings and profile (FR-ACC-01..05). */
export default function SettingsPage() {
  const prefs = usePreferences();
  const showToast = useUi((s) => s.showToast);
  const [draft, setDraft] = useState(() => ({
    theme: prefs.theme,
    fontSize: prefs.fontSize,
    lineHeight: prefs.lineHeight,
    width: prefs.width,
    defaultMode: prefs.defaultMode,
    colorLabels: prefs.colorLabels,
  }));

  // Server preferences may arrive after mount; follow them until the user edits.
  const [touched, setTouched] = useState(false);
  useEffect(() => {
    if (touched) return;
    setDraft({
      theme: prefs.theme,
      fontSize: prefs.fontSize,
      lineHeight: prefs.lineHeight,
      width: prefs.width,
      defaultMode: prefs.defaultMode,
      colorLabels: prefs.colorLabels,
    });
  }, [touched, prefs.theme, prefs.fontSize, prefs.lineHeight, prefs.width, prefs.defaultMode, prefs.colorLabels]);

  const edit = (patch: Partial<typeof draft>) => {
    setTouched(true);
    setDraft((d) => ({ ...d, ...patch }));
  };
  const setLabel = (color: HighlightColor, value: string) =>
    edit({ colorLabels: { ...draft.colorLabels, [color]: value.slice(0, MAX_COLOR_LABEL) } });

  const dirty =
    draft.theme !== prefs.theme ||
    draft.fontSize !== prefs.fontSize ||
    draft.lineHeight !== prefs.lineHeight ||
    draft.width !== prefs.width ||
    draft.defaultMode !== prefs.defaultMode ||
    HIGHLIGHT_COLORS.some((c) => draft.colorLabels[c] !== prefs.colorLabels[c]);

  function save() {
    prefs.set({ ...draft, colorLabels: { ...draft.colorLabels } });
    setTouched(false);
    showToast("Đã lưu cài đặt đọc");
  }

  const option = <T extends string | number>(value: T, current: T, label: string, pick: (v: T) => void) => (
    <button key={String(value)} type="button" role="radio" aria-checked={value === current} className="chip" onClick={() => pick(value)}>
      {label}
    </button>
  );

  return (
    <div className="mx-auto flex max-w-[1080px] flex-col gap-7">
      <h1 className="font-serif text-4xl font-medium sm:text-5xl">Cài đặt</h1>

      <section className="grid gap-6 lg:grid-cols-2">
        <div className="card flex flex-col gap-[22px] p-6 sm:p-7">
          <h2 className="font-serif text-[26px] font-medium">Trình đọc mặc định</h2>

          <div className="flex items-center justify-between">
            <span className="text-[15px] font-medium">Cỡ chữ</span>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                aria-label="Giảm cỡ chữ"
                className="icon-btn border border-field font-serif text-[15px]"
                disabled={draft.fontSize <= 14}
                onClick={() => edit({ fontSize: draft.fontSize - 1 })}
              >
                A
              </button>
              <span className="w-14 text-center text-[15px]" aria-live="polite">
                {draft.fontSize}px
              </span>
              <button
                type="button"
                aria-label="Tăng cỡ chữ"
                className="icon-btn border border-field font-serif text-[21px]"
                disabled={draft.fontSize >= 28}
                onClick={() => edit({ fontSize: draft.fontSize + 1 })}
              >
                A
              </button>
            </div>
          </div>
          <Row label="Giao diện">{THEMES.map(([v, l]) => option(v, draft.theme, l, (theme) => edit({ theme })))}</Row>
          <Row label="Giãn dòng">
            {LINE_HEIGHTS.map(([v, l]) => option(v, draft.lineHeight, l, (lineHeight) => edit({ lineHeight })))}
          </Row>
          <Row label="Độ rộng cột chữ">{WIDTHS.map(([v, l]) => option(v, draft.width, l, (width) => edit({ width })))}</Row>
          <Row label="Mở PDF ở chế độ">
            {MODES.map(([v, l]) => option(v, draft.defaultMode, l, (defaultMode) => edit({ defaultMode })))}
          </Row>

          <div className="flex flex-col gap-3 border-t border-line pt-5">
            <div className="flex items-center justify-between">
              <h3 className="text-[15px] font-semibold">Ý nghĩa màu highlight</h3>
              <button
                type="button"
                className="py-2 text-[13px] text-accent hover:underline"
                onClick={() => edit({ colorLabels: DEFAULT_COLOR_LABELS })}
              >
                Khôi phục mặc định
              </button>
            </div>
            <span className="text-[13px] leading-normal text-muted">
              Đặt tên cho từng màu. Tên hiện trong menu khi bôi đen, trên thẻ highlight và bộ lọc.
            </span>
            <div className="grid gap-2.5 sm:grid-cols-2">
              {HIGHLIGHT_COLORS.map((c) => (
                <label
                  key={c}
                  className="flex h-11 items-center gap-2.5 rounded-[10px] border border-field bg-page px-3 focus-within:border-accent"
                >
                  <span className="h-3.5 w-3.5 shrink-0 rounded-full" style={{ background: COLOR_DOT[c] }} />
                  <span className="sr-only">Ý nghĩa màu {COLOR_NAME[c]}</span>
                  <input
                    value={draft.colorLabels[c]}
                    onChange={(e) => setLabel(c, e.target.value)}
                    maxLength={MAX_COLOR_LABEL}
                    placeholder={`Màu ${COLOR_NAME[c]}`}
                    className="min-w-0 flex-1 bg-transparent text-sm text-ink outline-none"
                  />
                </label>
              ))}
            </div>
          </div>

          <button type="button" className="btn-primary h-[46px] self-start px-[22px]" onClick={save} disabled={!dirty}>
            Lưu cài đặt đọc
          </button>
        </div>

        <div
          data-theme={draft.theme}
          aria-label="Xem trước"
          className="flex flex-col gap-3.5 overflow-hidden rounded-[14px] border border-line bg-bg px-8 py-9 text-body sm:px-10"
        >
          <span className="eyebrow">XEM TRƯỚC · CỘT {draft.width}PX</span>
          <span className="font-serif text-[34px] font-medium text-ink">Tổng quát hóa</span>
          <p className="font-serif" style={{ fontSize: draft.fontSize, lineHeight: draft.lineHeight, maxWidth: draft.width }}>
            Điểm mấu chốt nằm ở chữ “tổng quát hóa”.{" "}
            <span className="hl-bg-yellow box-decoration-clone">
              Một mô hình tốt không phải mô hình nhớ đúng mọi ví dụ đã thấy
            </span>
            , mà là mô hình đoán đúng những ví dụ nó chưa từng gặp.
          </p>
          <div className="mt-auto flex flex-wrap gap-2 pt-2">
            {HIGHLIGHT_COLORS.map((c) => (
              <span key={c} className="inline-flex h-7 items-center gap-1.5 rounded-full bg-soft px-2.5 text-xs font-semibold text-ink">
                <span className="h-2.5 w-2.5 rounded-full" style={{ background: COLOR_DOT[c] }} />
                {colorLabel(draft.colorLabels, c)}
              </span>
            ))}
          </div>
          <span className="flex items-center gap-1.5 text-xs text-muted">
            <Icon name="note" size={14} />
            Các tùy chọn đọc được lưu theo tài khoản và áp dụng trên mọi thiết bị.
          </span>
        </div>
      </section>

      <AccountSettings />
    </div>
  );
}

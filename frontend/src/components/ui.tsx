"use client";

import { useEffect, useRef } from "react";

import { useUi } from "@/lib/ui-store";

export function Spinner({ label = "Đang tải…" }: { label?: string }) {
  return (
    <div role="status" className="flex items-center gap-3 text-sm text-muted">
      <span className="h-4 w-4 animate-spin rounded-full border-2 border-line border-t-accent" aria-hidden />
      {label}
    </div>
  );
}

const ALERT_TONE = {
  danger: "bg-danger-soft text-danger",
  success: "bg-success-soft text-success",
  info: "bg-soft text-body",
} as const;

export function Alert({ children, tone = "danger" }: { children: React.ReactNode; tone?: keyof typeof ALERT_TONE }) {
  return (
    <div role={tone === "danger" ? "alert" : "status"} className={`rounded-[10px] px-3.5 py-2.5 text-sm leading-relaxed ${ALERT_TONE[tone]}`}>
      {children}
    </div>
  );
}

/** Opens/closes a native <dialog> as a modal in sync with `open`. */
export function useModal(open: boolean) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return ref;
}

/** Confirmation dialog for irreversible actions (BR-14). */
export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel = "Xóa vĩnh viễn",
  cancelLabel = "Giữ lại",
  busy = false,
  confirmDisabled = false,
  tone = "danger",
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  children?: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  busy?: boolean;
  confirmDisabled?: boolean;
  /** "primary" for confirmations that do not destroy anything. */
  tone?: "danger" | "primary";
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const ref = useModal(open);

  return (
    <dialog
      ref={ref}
      role="alertdialog"
      aria-label={title}
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onCancel();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onCancel();
      }}
      className="dialog w-[min(calc(100vw-32px),420px)]"
    >
      <div className="flex flex-col gap-3.5 p-[26px]">
        <h2 className="font-serif text-2xl font-medium">{title}</h2>
        <div className="text-[15px] leading-relaxed text-body">{children}</div>
        <div className="mt-1.5 flex justify-end gap-2.5">
          <button type="button" className="btn-outline" onClick={onCancel} disabled={busy}>
            {cancelLabel}
          </button>
          <button type="button" className={tone === "danger" ? "btn-danger" : "btn-primary"} onClick={onConfirm} disabled={busy || confirmDisabled}>
            {busy ? "Đang xử lý…" : confirmLabel}
          </button>
        </div>
      </div>
    </dialog>
  );
}

export function Toast() {
  const { toast, hideToast } = useUi();
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(hideToast, 2600);
    return () => clearTimeout(t);
  }, [toast, hideToast]);
  if (!toast) return null;
  return (
    <div
      key={toast.id}
      role="status"
      className="fixed left-1/2 top-5 z-[60] -translate-x-1/2 rounded-full bg-menu px-5 py-3 text-sm font-medium text-menu-fg shadow-float"
    >
      {toast.text}
    </div>
  );
}

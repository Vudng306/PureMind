"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import { useT } from "@/lib/i18n";
import { settleSheet } from "@/lib/mobile";

import { Icon, type IconName } from "./icons";
import { useModal } from "./ui";

type Stop = "content" | "half" | "full";

const CONTENT_STOPS: readonly Stop[] = ["content"];
const TALL_STOPS: readonly Stop[] = ["half", "full"];
const HEIGHT: Record<Stop, string | undefined> = { content: undefined, half: "56dvh", full: "100dvh" };

/** A panel that rises from the bottom of a phone. It closes by dragging its handle down, tapping the handle or
 * the backdrop, or Esc. A `tall` sheet opens halfway and can be dragged up to nearly the full screen; typing in
 * it takes it there, so what is written stays in view above the keyboard. A `flush` sheet leaves the padding and
 * the scrolling to what it holds. */
export function BottomSheet({
  open,
  onClose,
  label,
  tall = false,
  flush = false,
  children,
}: {
  open: boolean;
  onClose: () => void;
  label: string;
  tall?: boolean;
  flush?: boolean;
  children: React.ReactNode;
}) {
  const t = useT();
  const ref = useModal(open);
  const stops = tall ? TALL_STOPS : CONTENT_STOPS;
  const [stop, setStop] = useState<Stop>(stops[0]);
  const [drag, setDrag] = useState(0);
  const gesture = useRef<{ y: number; at: number } | null>(null);
  const dragged = useRef(false);
  const pressedBackdrop = useRef(false);

  useEffect(() => {
    if (!open) return;
    setStop(stops[0]);
    setDrag(0);
  }, [open, stops]);

  function onPointerDown(e: React.PointerEvent<HTMLButtonElement>) {
    gesture.current = { y: e.clientY, at: e.timeStamp };
    dragged.current = false;
    e.currentTarget.setPointerCapture(e.pointerId);
  }

  function onPointerMove(e: React.PointerEvent) {
    if (!gesture.current) return;
    const dy = e.clientY - gesture.current.y;
    if (Math.abs(dy) > 6) dragged.current = true;
    if (dragged.current) setDrag(dy);
  }

  function onPointerUp(e: React.PointerEvent) {
    const start = gesture.current;
    gesture.current = null;
    setDrag(0);
    if (!start || !dragged.current) return;
    const next = settleSheet(stops, stop, e.clientY - start.y, e.timeStamp - start.at);
    if (next === "closed") onClose();
    else setStop(next);
  }

  const base = HEIGHT[stop];
  // Dragging up grows a tall sheet under the finger; dragging down moves the whole sheet.
  const height = base && drag < 0 ? `calc(${base} + ${-drag}px)` : base;

  return (
    <dialog
      ref={ref}
      aria-label={label}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      // Only a press that began on the backdrop closes: a drag of the handle can end there too.
      onPointerDown={(e) => {
        pressedBackdrop.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget && pressedBackdrop.current) onClose();
      }}
      onFocusCapture={(e) => {
        if (tall && /^(TEXTAREA|INPUT)$/.test(e.target.tagName)) setStop("full");
      }}
      className="sheet"
      style={{
        height,
        transform: drag > 0 ? `translateY(${drag}px)` : undefined,
        transition: drag === 0 ? "transform 160ms ease-out, height 160ms ease-out" : "none",
      }}
    >
      <button
        type="button"
        aria-label={t("common.close")}
        className="flex h-7 w-full shrink-0 touch-none items-center justify-center"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => {
          gesture.current = null;
          setDrag(0);
        }}
        onClick={() => {
          if (dragged.current) dragged.current = false;
          else onClose();
        }}
      >
        <span aria-hidden className="h-1 w-10 rounded-full bg-line" />
      </button>
      <div
        className={
          flush
            ? "flex min-h-0 flex-1 flex-col"
            : "min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 pb-[calc(12px+env(safe-area-inset-bottom))]"
        }
      >
        {open && children}
      </div>
    </dialog>
  );
}

export type SheetAction = {
  key: string;
  label: string;
  icon: IconName;
  href?: string;
  onSelect?: () => void;
  danger?: boolean;
};

/** A bottom sheet holding a list of actions, with room above them for what the actions are about. */
export function ActionSheet({
  open,
  onClose,
  label,
  actions,
  children,
}: {
  open: boolean;
  onClose: () => void;
  label: string;
  actions: SheetAction[];
  children?: React.ReactNode;
}) {
  return (
    <BottomSheet open={open} onClose={onClose} label={label}>
      {children}
      <ul className="flex flex-col gap-0.5">
        {actions.map((action) => {
          const className = `flex h-12 w-full items-center gap-3 rounded-xl px-2.5 text-left text-[15px] hover:bg-soft active:bg-soft ${
            action.danger ? "text-danger" : "text-ink"
          }`;
          const body = (
            <>
              <Icon name={action.icon} />
              <span className="min-w-0 flex-1 truncate">{action.label}</span>
            </>
          );
          return (
            <li key={action.key}>
              {action.href ? (
                <Link href={action.href} className={className} onClick={onClose}>
                  {body}
                </Link>
              ) : (
                <button
                  type="button"
                  className={className}
                  onClick={() => {
                    onClose();
                    action.onSelect?.();
                  }}
                >
                  {body}
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </BottomSheet>
  );
}

"use client";

import { useEffect, useRef, useState } from "react";

/** Keep overlays inside the visible viewport when Safari opens its keyboard. */
export function useVisualViewport() {
  useEffect(() => {
    const viewport = window.visualViewport;
    const update = () => {
      const style = document.documentElement.style;
      style.setProperty("--visible-height", `${viewport?.height ?? window.innerHeight}px`);
      style.setProperty("--visible-top", `${viewport?.offsetTop ?? 0}px`);
      style.setProperty("--keyboard-inset", `${Math.max(0, window.innerHeight - (viewport?.height ?? window.innerHeight) - (viewport?.offsetTop ?? 0))}px`);
    };
    update();
    viewport?.addEventListener("resize", update);
    viewport?.addEventListener("scroll", update);
    return () => {
      viewport?.removeEventListener("resize", update);
      viewport?.removeEventListener("scroll", update);
      for (const key of ["--visible-height", "--visible-top", "--keyboard-inset"]) document.documentElement.style.removeProperty(key);
    };
  }, []);
}

/** Drag the handle up to expand; down to collapse, then dismiss. Reading stays interactive. */
export function useSheet(onClose: () => void) {
  const [expanded, setExpanded] = useState(false);
  const start = useRef<number | null>(null);
  return {
    expanded,
    handle: {
      onPointerDown: (event: React.PointerEvent<HTMLButtonElement>) => {
        start.current = event.clientY;
        event.currentTarget.setPointerCapture(event.pointerId);
      },
      onPointerUp: (event: React.PointerEvent<HTMLButtonElement>) => {
        if (start.current === null) return;
        const delta = event.clientY - start.current;
        start.current = null;
        if (delta < -35) setExpanded(true);
        else if (delta > 50) {
          if (expanded) setExpanded(false);
          else onClose();
        } else setExpanded((value) => !value);
      },
      onPointerCancel: () => { start.current = null; },
      onClick: (event: React.MouseEvent<HTMLButtonElement>) => { if (event.detail === 0) setExpanded((value) => !value); },
      onKeyDown: (event: React.KeyboardEvent<HTMLButtonElement>) => {
        if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setExpanded((value) => !value); }
        if (event.key === "ArrowUp") setExpanded(true);
        if (event.key === "ArrowDown") setExpanded(false);
      },
    },
  };
}


/** Native one-finger scrolling plus two-finger zoom inside a canvas, without blocking page zoom elsewhere. */
export function useTouchZoom(ref: React.RefObject<HTMLDivElement | null>, scale: number, onScale: (scale: number) => void, min = 0.25, max = 4) {
  const latest = useRef({ scale, onScale, min, max });
  latest.current = { scale, onScale, min, max };
  useEffect(() => {
    const box = ref.current;
    if (!box) return;
    let initial: { distance: number; scale: number; x: number; y: number; left: number; top: number } | null = null;
    let frame = 0;
    const distance = (touches: TouchList) => Math.hypot(touches[0].clientX - touches[1].clientX, touches[0].clientY - touches[1].clientY);
    const start = (event: TouchEvent) => {
      if (event.touches.length !== 2) return;
      const rect = box.getBoundingClientRect();
      const x = (event.touches[0].clientX + event.touches[1].clientX) / 2 - rect.left;
      const y = (event.touches[0].clientY + event.touches[1].clientY) / 2 - rect.top;
      initial = { distance: distance(event.touches), scale: latest.current.scale, x, y, left: box.scrollLeft, top: box.scrollTop };
    };
    const move = (event: TouchEvent) => {
      if (!initial || event.touches.length !== 2) return;
      event.preventDefault();
      const next = Math.max(latest.current.min, Math.min(latest.current.max, initial.scale * distance(event.touches) / Math.max(1, initial.distance)));
      const ratio = next / initial.scale;
      const origin = initial;
      latest.current.onScale(next);
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        box.scrollLeft = (origin.left + origin.x) * ratio - origin.x;
        box.scrollTop = (origin.top + origin.y) * ratio - origin.y;
      });
    };
    const end = () => { initial = null; };
    box.addEventListener("touchstart", start, { passive: true });
    box.addEventListener("touchmove", move, { passive: false });
    box.addEventListener("touchend", end);
    box.addEventListener("touchcancel", end);
    return () => {
      cancelAnimationFrame(frame);
      box.removeEventListener("touchstart", start);
      box.removeEventListener("touchmove", move);
      box.removeEventListener("touchend", end);
      box.removeEventListener("touchcancel", end);
    };
  }, [ref]);
}
